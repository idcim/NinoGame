/** /api/children/:id/reports/*: 家长后台统计数据 (P3 使用时长报表)。
 *
 * 数据源:
 *   - app_sessions (active_seconds 总和, 由 Agent UsageReporter 每 5min 推上来)
 *   - token_ledger (扣分/挣分按 reason 聚合)
 *
 * 端点:
 *   GET  /api/children/:id/reports/daily?days=14
 *        每天 active_seconds + tokens_consumed + session_count
 *   GET  /api/children/:id/reports/top-apps?days=14&limit=10
 *        Top N 应用按 active_seconds 排序
 */
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

async function ensureOwnership(parent_id: string, child_id: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "NinoGame".children WHERE id = $1 AND parent_id = $2`,
    [child_id, parent_id],
  );
  return Number(r.rows[0].count) > 0;
}

export async function registerReportRoutes(app: FastifyInstance) {
  // ── 每日聚合 ─────────────────────────────────────────────
  app.get(
    "/api/children/:id/reports/daily",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string>;
      const days = Math.max(1, Math.min(90, Number(q.days) || 14));
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      // active_seconds: 每天聚合 (app_sessions 已经是 5min 上报后的历史)
      const sessions = await pool.query<{
        date: string;
        active_seconds: string;
        session_count: string;
      }>(
        `SELECT started_at::date AS date,
                COALESCE(SUM(active_seconds), 0)::text AS active_seconds,
                COUNT(*)::text AS session_count
           FROM "NinoGame".app_sessions
          WHERE child_id = $1
            AND started_at >= CURRENT_DATE - ($2::int - 1 || ' days')::interval
          GROUP BY started_at::date
          ORDER BY started_at::date`,
        [child_id, days],
      );
      // tokens_consumed: 每天 app_consumption 累计 (server 单一权威 ledger)
      const ledger = await pool.query<{ date: string; tokens_consumed: string }>(
        `SELECT l.occurred_at::date AS date,
                COALESCE(SUM(-l.delta), 0)::text AS tokens_consumed
           FROM "NinoGame".token_ledger l
           JOIN "NinoGame".wallets w ON w.id = l.wallet_id
          WHERE w.child_id = $1
            AND l.reason = 'app_consumption'
            AND l.occurred_at >= CURRENT_DATE - ($2::int - 1 || ' days')::interval
          GROUP BY l.occurred_at::date`,
        [child_id, days],
      );

      // 合并 sessions + ledger 到同一日期 map, 补齐没数据的日子
      const map = new Map<
        string,
        { date: string; active_seconds: number; tokens_consumed: number; session_count: number }
      >();
      for (const r of sessions.rows) {
        map.set(r.date, {
          date: r.date,
          active_seconds: Number(r.active_seconds),
          tokens_consumed: 0,
          session_count: Number(r.session_count),
        });
      }
      for (const r of ledger.rows) {
        const existing = map.get(r.date);
        if (existing) {
          existing.tokens_consumed = Number(r.tokens_consumed);
        } else {
          map.set(r.date, {
            date: r.date,
            active_seconds: 0,
            tokens_consumed: Number(r.tokens_consumed),
            session_count: 0,
          });
        }
      }
      // 按日期升序
      const out = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
      return { days: out };
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
      const r = await pool.query<{
        app_identifier: string;
        category: string;
        total_active_seconds: string;
        total_tokens: string;
        session_count: string;
      }>(
        `SELECT app_identifier,
                category,
                COALESCE(SUM(active_seconds), 0)::text AS total_active_seconds,
                COALESCE(SUM(tokens_consumed), 0)::text AS total_tokens,
                COUNT(*)::text AS session_count
           FROM "NinoGame".app_sessions
          WHERE child_id = $1
            AND started_at >= CURRENT_DATE - ($2::int - 1 || ' days')::interval
          GROUP BY app_identifier, category
          ORDER BY SUM(active_seconds) DESC
          LIMIT $3`,
        [child_id, days, limit],
      );
      return {
        apps: r.rows.map((row) => ({
          app_identifier: row.app_identifier,
          category: row.category,
          total_active_seconds: Number(row.total_active_seconds),
          total_tokens: Number(row.total_tokens),
          session_count: Number(row.session_count),
        })),
      };
    },
  );
}
