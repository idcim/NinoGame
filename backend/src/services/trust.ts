/** 信任值机制 (CLAUDE.md §8.7)。
 *
 * 简版 MVP (P2 落地):
 *   每次家长 approve/reject unlock_request 后调用 recompute(child_id)。
 *   逻辑:
 *     近 30 天 (UTC) 决策样本 >= MIN_SAMPLE 才动:
 *       reject_rate > 0.30 -> trust -= 1 (最低 0)
 *       reject_rate < 0.05 -> trust += 1 (最高 5)
 *     每次变动 INSERT trust_changes + UPDATE children.trust_level
 *   带"今天已变动过"的护栏 (避免一次审批触发涨/跌循环)。
 *
 * 完整版 (后续):
 *   - 连续 4 周无被拒 → +1
 *   - 30 天责任清单 ≥90% → +1
 *   - 防刷 alert 命中 → -1
 *   - 按周聚合, 周日 cron 跑
 */
import { pool } from "../db.js";

const TRUST_MIN = 0;
const TRUST_MAX = 5;
const MIN_SAMPLE = 5; // 近 30 天至少 5 个决策才评估
const WINDOW_DAYS = 30;
const UP_THRESHOLD = 0.05;
const DOWN_THRESHOLD = 0.30;

interface DecisionStats {
  total: number;
  rejected: number;
  reject_rate: number;
}

async function fetchRecentStats(child_id: string): Promise<DecisionStats> {
  const r = await pool.query<{ total: string; rejected: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected
     FROM "NinoGame".unlock_requests
     WHERE child_id = $1
       AND status IN ('approved', 'rejected')
       AND parent_decision_at >= NOW() - ($2::int || ' days')::interval`,
    [child_id, WINDOW_DAYS],
  );
  const total = Number(r.rows[0].total);
  const rejected = Number(r.rows[0].rejected);
  return {
    total,
    rejected,
    reject_rate: total > 0 ? rejected / total : 0,
  };
}

/** 检查今天有没有变动过, 一日只能 ±1。 */
async function changedTodayAlready(child_id: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM "NinoGame".trust_changes
        WHERE child_id = $1
          AND triggered_at >= NOW() - INTERVAL '24 hours'
     ) AS exists`,
    [child_id],
  );
  return Boolean(r.rows[0]?.exists);
}

export async function recomputeTrust(child_id: string): Promise<{
  current_level: number;
  changed: boolean;
  delta: number;
  reason: string;
}> {
  const cur = await pool.query<{ trust_level: number }>(
    `SELECT trust_level FROM "NinoGame".children WHERE id = $1`,
    [child_id],
  );
  if (cur.rows.length === 0) {
    return { current_level: 0, changed: false, delta: 0, reason: "no_child" };
  }
  const current = Number(cur.rows[0].trust_level);

  const stats = await fetchRecentStats(child_id);
  if (stats.total < MIN_SAMPLE) {
    return {
      current_level: current,
      changed: false,
      delta: 0,
      reason: `sample_too_small (${stats.total}/${MIN_SAMPLE})`,
    };
  }

  if (await changedTodayAlready(child_id)) {
    return {
      current_level: current,
      changed: false,
      delta: 0,
      reason: "cooldown_24h",
    };
  }

  let delta = 0;
  let reason = "stable";
  if (stats.reject_rate > DOWN_THRESHOLD && current > TRUST_MIN) {
    delta = -1;
    reason = `reject_rate_${(stats.reject_rate * 100).toFixed(0)}pct_too_high`;
  } else if (stats.reject_rate < UP_THRESHOLD && current < TRUST_MAX) {
    delta = +1;
    reason = `reject_rate_${(stats.reject_rate * 100).toFixed(0)}pct_low_consistent`;
  }

  if (delta === 0) {
    return { current_level: current, changed: false, delta: 0, reason };
  }

  const newLevel = Math.max(TRUST_MIN, Math.min(TRUST_MAX, current + delta));
  // 事务: ledger + level 一起
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "NinoGame".trust_changes (child_id, delta, new_level, reason)
       VALUES ($1, $2, $3, $4)`,
      [child_id, delta, newLevel, reason],
    );
    await client.query(
      `UPDATE "NinoGame".children SET trust_level = $1 WHERE id = $2`,
      [newLevel, child_id],
    );
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  return { current_level: newLevel, changed: true, delta, reason };
}
