/** /api/children/:id/reports/*: 家长后台统计数据 (P3 使用时长报表)。
 *
 * 数据源:
 *   - app_sessions (active_seconds 总和, 由 Agent UsageReporter 每 5min 推上来)
 *   - token_ledger (扣分/挣分按 reason 聚合)
 *
 * 端点:
 *   GET  /api/children/:id/reports/daily?days=14&granularity=day|week|month
 *        v0.4.4+: granularity 控制桶宽
 *          day   每天    最多 90 天  (向后兼容默认)
 *          week  每周    最多 26 周  ISO 周, 周一开始
 *          month 每月    最多 24 月
 *        返回字段统一: {period_start, period_end, active_seconds,
 *                       tokens_consumed, session_count}
 *   GET  /api/children/:id/reports/top-apps?days=14&limit=10
 *        Top N 应用按 active_seconds 排序
 */
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

type Granularity = "day" | "week" | "month";

interface GranularityConfig {
  trunc: string;       // PG date_trunc 单位
  step: string;        // PG interval 步长
  max_periods: number; // 上限
  label_format: string;
}

const GRANULARITY_CONFIG: Record<Granularity, GranularityConfig> = {
  day:   { trunc: "day",   step: "1 day",   max_periods: 90, label_format: "YYYY-MM-DD" },
  week:  { trunc: "week",  step: "1 week",  max_periods: 26, label_format: "YYYY-WW" },
  month: { trunc: "month", step: "1 month", max_periods: 24, label_format: "YYYY-MM" },
};

async function ensureOwnership(parent_id: string, child_id: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "NinoGame".children WHERE id = $1 AND parent_id = $2`,
    [child_id, parent_id],
  );
  return Number(r.rows[0].count) > 0;
}

export async function registerReportRoutes(app: FastifyInstance) {
  // ── 时序聚合 (day / week / month) ────────────────────────
  app.get(
    "/api/children/:id/reports/daily",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string>;
      const granRaw = (q.granularity || "day").toLowerCase();
      if (!["day", "week", "month"].includes(granRaw)) {
        return reply.badRequest("granularity 必须是 day / week / month");
      }
      const granularity = granRaw as Granularity;
      const cfg = GRANULARITY_CONFIG[granularity];
      // periods (新参数) 优先, days 旧名向后兼容
      const reqPeriods = Number(q.periods) || Number(q.days) || 14;
      const periods = Math.max(1, Math.min(cfg.max_periods, reqPeriods));
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      // 注意 ::date::text — node-pg 把裸 PG date 反序列化为 JS Date 对象, 用 Date 当 Map key
      // 会让 sessions/ledger 同日合并失败 + 后续 .localeCompare 报 TypeError, 强制 text。
      //
      // 时间窗口算法: 取 "本期开始 - (periods-1) 个步长", 让 cohort 完整覆盖 N 期
      // 例 weekly N=4: from = date_trunc('week', NOW()) - INTERVAL '3 weeks'
      const sessions = await pool.query<{
        period_start: string;
        active_seconds: string;
        session_count: string;
      }>(
        `SELECT date_trunc($3, started_at)::date::text AS period_start,
                COALESCE(SUM(active_seconds), 0)::text AS active_seconds,
                COUNT(*)::text AS session_count
           FROM "NinoGame".app_sessions
          WHERE child_id = $1
            AND started_at >= date_trunc($3, NOW()) - ($2::int - 1 || ' ' || $4)::interval
          GROUP BY date_trunc($3, started_at)
          ORDER BY date_trunc($3, started_at)`,
        [child_id, periods, cfg.trunc, cfg.step],
      );
      const ledger = await pool.query<{ period_start: string; tokens_consumed: string }>(
        `SELECT date_trunc($3, l.occurred_at)::date::text AS period_start,
                COALESCE(SUM(-l.delta), 0)::text AS tokens_consumed
           FROM "NinoGame".token_ledger l
           JOIN "NinoGame".wallets w ON w.id = l.wallet_id
          WHERE w.child_id = $1
            AND l.reason = 'app_consumption'
            AND l.occurred_at >= date_trunc($3, NOW()) - ($2::int - 1 || ' ' || $4)::interval
          GROUP BY date_trunc($3, l.occurred_at)`,
        [child_id, periods, cfg.trunc, cfg.step],
      );

      // 合并到 (period_start) Map, 补 0
      interface Row {
        period_start: string;
        period_end: string;
        active_seconds: number;
        tokens_consumed: number;
        session_count: number;
      }
      const map = new Map<string, Row>();
      const periodEnd = (start: string): string => {
        const d = new Date(start + "T00:00:00Z");
        if (granularity === "day") {
          // 单日, end == start
          return start;
        }
        if (granularity === "week") {
          d.setUTCDate(d.getUTCDate() + 6);
        } else {
          // month: 月末
          d.setUTCMonth(d.getUTCMonth() + 1);
          d.setUTCDate(0);
        }
        return d.toISOString().slice(0, 10);
      };
      for (const r of sessions.rows) {
        map.set(r.period_start, {
          period_start: r.period_start,
          period_end: periodEnd(r.period_start),
          active_seconds: Number(r.active_seconds),
          tokens_consumed: 0,
          session_count: Number(r.session_count),
        });
      }
      for (const r of ledger.rows) {
        const ex = map.get(r.period_start);
        if (ex) ex.tokens_consumed = Number(r.tokens_consumed);
        else map.set(r.period_start, {
          period_start: r.period_start,
          period_end: periodEnd(r.period_start),
          active_seconds: 0,
          tokens_consumed: Number(r.tokens_consumed),
          session_count: 0,
        });
      }
      const out = Array.from(map.values()).sort((a, b) =>
        a.period_start.localeCompare(b.period_start),
      );

      // 兼容旧前端: 同时返回 days 字段 + period_start 别名 date,
      // 新前端用 periods 拿规范字段
      return {
        granularity,
        periods,
        days: out.map((r) => ({
          date: r.period_start,         // legacy alias
          period_start: r.period_start,
          period_end: r.period_end,
          active_seconds: r.active_seconds,
          tokens_consumed: r.tokens_consumed,
          session_count: r.session_count,
        })),
      };
    },
  );

  // ── 类别细分 (v0.4.5: 屏幕使用时长按类别占比) ─────────────
  // CLAUDE.md §22 决策 #33 后, category 不再参与扣分决策, 但 app_sessions 仍存
  // category 列 (rule_engine 分类) — 这里给家长看 "消遣/学习/中性" 时长分布,
  // 纯描述性, 不引导行为. 桶宽 / 时长 范围跟 /reports/daily 保持一致.
  app.get(
    "/api/children/:id/reports/category-breakdown",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string>;
      const granRaw = (q.granularity || "day").toLowerCase();
      if (!["day", "week", "month"].includes(granRaw)) {
        return reply.badRequest("granularity 必须是 day / week / month");
      }
      const granularity = granRaw as Granularity;
      const cfg = GRANULARITY_CONFIG[granularity];
      const reqPeriods = Number(q.periods) || Number(q.days) || 14;
      const periods = Math.max(1, Math.min(cfg.max_periods, reqPeriods));
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const r = await pool.query<{
        category: string;
        active_seconds: string;
        session_count: string;
      }>(
        `SELECT COALESCE(category, 'unknown') AS category,
                COALESCE(SUM(active_seconds), 0)::text AS active_seconds,
                COUNT(*)::text AS session_count
           FROM "NinoGame".app_sessions
          WHERE child_id = $1
            AND started_at >= date_trunc($3, NOW()) - ($2::int - 1 || ' ' || $4)::interval
          GROUP BY COALESCE(category, 'unknown')
          ORDER BY SUM(active_seconds) DESC`,
        [child_id, periods, cfg.trunc, cfg.step],
      );
      const rows = r.rows.map((row) => ({
        category: row.category,
        active_seconds: Number(row.active_seconds),
        session_count: Number(row.session_count),
      }));
      const total = rows.reduce((s, x) => s + x.active_seconds, 0);
      return {
        granularity,
        periods,
        total_active_seconds: total,
        categories: rows.map((row) => ({
          ...row,
          percentage: total > 0 ? Math.round((row.active_seconds / total) * 1000) / 10 : 0,
        })),
      };
    },
  );

  // ── Top 应用 ─────────────────────────────────────────────
  app.get(
    "/api/children/:id/reports/top-apps",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string>;
      const days = Math.max(1, Math.min(90, Number(q.days) || 14));
      const limit = Math.max(1, Math.min(50, Number(q.limit) || 10));
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      // app_categories LATERAL: 优先取该孩子的 override (child_id=$1), 退到全局
      // (child_id IS NULL); LOWER 比对让 "Chrome.exe" 也能命中 "chrome.exe"
      const r = await pool.query<{
        app_identifier: string;
        category: string;
        display_name: string | null;
        sub_type: string | null;
        total_active_seconds: string;
        total_tokens: string;
        session_count: string;
      }>(
        `SELECT s.app_identifier,
                s.category,
                ac.display_name,
                ac.sub_type,
                COALESCE(SUM(s.active_seconds), 0)::text AS total_active_seconds,
                COALESCE(SUM(s.tokens_consumed), 0)::text AS total_tokens,
                COUNT(*)::text AS session_count
           FROM "NinoGame".app_sessions s
           LEFT JOIN LATERAL (
             SELECT display_name, sub_type
               FROM "NinoGame".app_categories
              WHERE LOWER(app_identifier) = LOWER(s.app_identifier)
                AND (child_id = $1 OR child_id IS NULL)
              ORDER BY (child_id = $1) DESC NULLS LAST
              LIMIT 1
           ) ac ON TRUE
          WHERE s.child_id = $1
            AND s.started_at >= CURRENT_DATE - ($2::int - 1 || ' days')::interval
          GROUP BY s.app_identifier, s.category, ac.display_name, ac.sub_type
          ORDER BY SUM(s.active_seconds) DESC
          LIMIT $3`,
        [child_id, days, limit],
      );
      return {
        apps: r.rows.map((row) => ({
          app_identifier: row.app_identifier,
          category: row.category,
          display_name: row.display_name,
          sub_type: row.sub_type,
          total_active_seconds: Number(row.total_active_seconds),
          total_tokens: Number(row.total_tokens),
          session_count: Number(row.session_count),
        })),
      };
    },
  );
}
