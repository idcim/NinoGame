/** 成熟度档位自动升级建议 (CLAUDE.md §1.2 / §8.7 / 决策 #43).
 *
 * 触发: 每次 recomputeTrust 后, 若新 trust_level 进入 4/5 区间, 调用本服务.
 *
 * 决策表:
 *   trust >= 4 + maturity ∈ {strict, negotiable} → 建议 'advisory'
 *   trust = 5 + maturity = 'advisory'            → 建议 'self_regulated'
 *   其它 → no-op
 *
 * 防爆: children.last_maturity_suggestion_at — 同 child 30 天内只发一次, 与
 *       suggested_mode 无关 (用户改不改 mode 都不重复发, 否则家长嫌烦).
 *
 * 副作用:
 *   - INSERT events(event_type='maturity_upgrade_suggestion', payload={from,to,trust_level})
 *   - UPDATE children.last_maturity_suggestion_at = NOW()
 *   - publishToParent → 浏览器实时事件流 + Dashboard badge
 *   - notify(info) → 企微 + SMTP 推送 (信息级, 不当告警搞)
 *
 * 软失败: 任何一步出错都吞掉日志, 不抛, 不阻 recomputeTrust 业务.
 */
import type { FastifyBaseLogger } from "fastify";
import { pool } from "../db.js";
import { publishToParent } from "../ws/event_bus.js";
import { notify } from "./notifier/index.js";

const COOLDOWN_DAYS = 30;

type Maturity = "strict" | "negotiable" | "advisory" | "self_regulated";

const MATURITY_LABEL: Record<Maturity, string> = {
  strict: "严格",
  negotiable: "协商",
  advisory: "建议",
  self_regulated: "自管",
};

interface ChildState {
  parent_id: string;
  display_name: string | null;
  username: string;
  maturity_mode: Maturity;
  trust_level: number;
  last_suggestion_at: string | null;
}

function decideTarget(state: ChildState): Maturity | null {
  const { maturity_mode, trust_level } = state;
  if (trust_level >= 5 && maturity_mode === "advisory") return "self_regulated";
  if (trust_level >= 4 && (maturity_mode === "strict" || maturity_mode === "negotiable")) {
    return "advisory";
  }
  return null;
}

export interface SuggestResult {
  suggested: boolean;
  reason: string;
  from?: Maturity;
  to?: Maturity;
}

export async function suggestMaturityUpgrade(
  child_id: string,
  logger?: FastifyBaseLogger,
): Promise<SuggestResult> {
  // 拉孩子状态 + 上次建议时间
  const r = await pool.query<ChildState>(
    `SELECT parent_id, display_name, username,
            maturity_mode, trust_level,
            last_maturity_suggestion_at::text AS last_suggestion_at
       FROM "NinoGame".children
      WHERE id = $1`,
    [child_id],
  );
  if (r.rows.length === 0) {
    return { suggested: false, reason: "no_child" };
  }
  const state = r.rows[0];

  const target = decideTarget(state);
  if (!target) {
    return {
      suggested: false,
      reason: `no_target (trust=${state.trust_level}, mode=${state.maturity_mode})`,
    };
  }

  // 30 天 cooldown
  if (state.last_suggestion_at) {
    const last = new Date(state.last_suggestion_at).getTime();
    const ageMs = Date.now() - last;
    if (ageMs < COOLDOWN_DAYS * 24 * 60 * 60 * 1000) {
      return {
        suggested: false,
        reason: `cooldown (last ${Math.round(ageMs / 86_400_000)}d ago)`,
      };
    }
  }

  const payload = {
    from: state.maturity_mode,
    to: target,
    trust_level: state.trust_level,
  };
  const occurred_at = new Date().toISOString();

  // 写 events + 更新 cooldown 时间戳 (一个事务保证一致)
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "NinoGame".events (child_id, device_id, event_type, payload, occurred_at)
       VALUES ($1, NULL, 'maturity_upgrade_suggestion', $2::jsonb, NOW())`,
      [child_id, JSON.stringify(payload)],
    );
    // 同时清掉 dismissed_maturity_target: 如果家长之前"暂不升级"过老的 target,
    // 而新建议的是个更高档 (例 dismissed='advisory', 新 target='self_regulated'),
    // 不该被旧 dismiss 状态压住. 简化逻辑: 任何新建议都清零 dismiss.
    await client.query(
      `UPDATE "NinoGame".children
          SET last_maturity_suggestion_at = NOW(),
              dismissed_maturity_target = NULL
        WHERE id = $1`,
      [child_id],
    );
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    logger?.warn({ err, child_id }, "maturity_upgrade_suggester: 入库失败");
    return { suggested: false, reason: "db_error" };
  } finally {
    client.release();
  }

  // 推浏览器 + push 通道 (软失败)
  publishToParent({
    parent_id: state.parent_id,
    child_id,
    device_id: null,
    event_type: "maturity_upgrade_suggestion",
    payload,
    occurred_at,
  });

  if (logger) {
    const who = state.display_name || state.username;
    void notify(logger, {
      severity: "info",
      subject: `成熟度升级建议: ${who}`,
      body:
        `${who} 的信任值已升到 Lv${state.trust_level}, 系统建议把成熟度档位从` +
        `「${MATURITY_LABEL[state.maturity_mode]}」升到「${MATURITY_LABEL[target]}」.\n` +
        `——这是"让系统逐步退场"的一步, 不强制. 同意请在家长后台一键应用; 不同意忽略即可,\n` +
        `30 天后视信任值情况会再次提示.`,
      dedupe_key: `maturity_suggest:${child_id}:${target}`,
    }).catch(() => undefined);
  }

  logger?.info(
    { child_id, from: state.maturity_mode, to: target, trust_level: state.trust_level },
    "maturity_upgrade_suggestion emitted",
  );

  return { suggested: true, reason: "ok", from: state.maturity_mode, to: target };
}
