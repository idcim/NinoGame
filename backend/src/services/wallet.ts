/** 服务端钱包操作 — 现在是 token 经济的权威源。
 *
 * 关键: ensureTodayGrant 幂等。即使被并发触发或 Agent 频繁断重连,
 * 当天最多发一次 daily_grant。
 *
 * 配额按 children.quota_overrides JSONB 读 weekday/weekend base;
 * 没设按 balanced 档默认 30/90。
 *
 * 日期边界: Postgres 容器 TZ = Asia/Shanghai (compose 里设的), 所以
 * CURRENT_DATE = 上海日历日, 跟孩子作息一致。
 */
import { pool } from "../db.js";

interface QuotaOverrides {
  weekday_base_tokens?: number;
  weekend_base_tokens?: number;
}

const DEFAULTS = {
  weekday: 30,
  weekend: 90,
};

function pickBaseTokens(overrides: QuotaOverrides | null, isWeekend: boolean): number {
  const o = overrides || {};
  if (isWeekend) {
    return Number.isFinite(o.weekend_base_tokens)
      ? Number(o.weekend_base_tokens)
      : DEFAULTS.weekend;
  }
  return Number.isFinite(o.weekday_base_tokens)
    ? Number(o.weekday_base_tokens)
    : DEFAULTS.weekday;
}

/** 拿孩子当前余额; 没钱包行就返回 0 (理论上不该, children 创建时自动开钱包)。 */
export async function getBalance(child_id: string): Promise<number> {
  const r = await pool.query<{ balance: number }>(
    `SELECT balance FROM "NinoGame".wallets WHERE child_id = $1`,
    [child_id],
  );
  return r.rows[0]?.balance ?? 0;
}

/** 幂等发放今日基础 token。返回 (applied_delta, new_balance)。
 * 一天只会发一次, 即使被并发调用 (行锁 + 重复查询保护)。
 */
export async function ensureTodayGrant(child_id: string): Promise<{
  applied: number;
  balance: number;
  reason: string;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 拿 wallet 行锁; 防并发双发
    const w = await client.query<{ id: string; balance: number }>(
      `SELECT id, balance FROM "NinoGame".wallets WHERE child_id = $1 FOR UPDATE`,
      [child_id],
    );
    if (w.rows.length === 0) {
      await client.query("ROLLBACK");
      return { applied: 0, balance: 0, reason: "no_wallet" };
    }
    const walletId = w.rows[0].id;
    const before = Number(w.rows[0].balance);

    // 当天是否已发过
    const dup = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM "NinoGame".token_ledger
          WHERE wallet_id = $1
            AND reason = 'daily_grant'
            AND occurred_at::date = CURRENT_DATE
       ) AS exists`,
      [walletId],
    );
    if (dup.rows[0]?.exists) {
      await client.query("COMMIT");
      return { applied: 0, balance: before, reason: "already_granted_today" };
    }

    // 读 quota_overrides 算今日额度
    const c = await client.query<{ quota_overrides: QuotaOverrides | null }>(
      `SELECT quota_overrides FROM "NinoGame".children WHERE id = $1`,
      [child_id],
    );
    const overrides = c.rows[0]?.quota_overrides ?? null;
    const dow = new Date().getDay(); // 0=Sun, 6=Sat; 简化用 server 本地时
    // 注意: 严格上海日历需要走 PG; 这里用 JS 也足够,
    // 跟 PG CURRENT_DATE 偶尔差 1 小时 (跨午夜并发); 影响轻微
    const isWeekend = dow === 0 || dow === 6;
    const delta = pickBaseTokens(overrides, isWeekend);

    if (delta <= 0) {
      await client.query("COMMIT");
      return { applied: 0, balance: before, reason: "zero_grant" };
    }

    const after = before + delta;
    await client.query(
      `INSERT INTO "NinoGame".token_ledger
         (wallet_id, delta, balance_after, reason, occurred_at)
       VALUES ($1, $2, $3, 'daily_grant', NOW())`,
      [walletId, delta, after],
    );
    await client.query(
      `UPDATE "NinoGame".wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
      [after, walletId],
    );

    await client.query("COMMIT");
    return { applied: delta, balance: after, reason: "granted" };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
