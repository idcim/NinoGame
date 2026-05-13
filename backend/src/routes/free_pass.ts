/** /api/free-pass: 家长一键放行 (CLAUDE.md §14.4)。
 *
 * 不消耗 token、不被规则拦截; 持续墙上时间。一个孩子同时只能有一段活跃限免,
 * 启动新一段时会先终止旧的 (避免叠加导致家长困惑)。
 *
 * 行为:
 *   - POST /api/free-pass        启动 (body: {child_id, duration_minutes, reason?})
 *     1. 关掉该孩子所有 active 期 (ended_at=NOW, ended_by='superseded')
 *     2. INSERT 新 free_pass_periods
 *     3. push start_free_pass {duration_minutes, expires_at} 给该孩子所有在线 Agent
 *   - POST /api/free-pass/:id/end 结束 (手动停止, ended_by='parent_manual')
 *     push end_free_pass 给所有在线 Agent
 *   - GET  /api/free-pass/active?child_id=X 当前活跃段 + 剩余秒数
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { pushToDevice } from "../ws/agent.js";

const StartBody = z.object({
  child_id: z.string().uuid(),
  duration_minutes: z.number().int().min(1).max(720), // 1 分钟 - 12 小时
  reason: z.string().max(512).optional(),
});

interface FreePassRow {
  id: string;
  child_id: string;
  started_at: string;
  ended_at: string | null;
  expected_duration_minutes: number | null;
  reason: string | null;
  ended_by: string | null;
}

async function ensureOwnership(parent_id: string, child_id: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "NinoGame".children WHERE id = $1 AND parent_id = $2`,
    [child_id, parent_id],
  );
  return Number(r.rows[0].count) > 0;
}

/** 查询某孩子当前活跃的限免 (未结束 且 墙上时间还没到期)。 */
export async function getActiveFreePass(child_id: string): Promise<{
  id: string;
  started_at: string;
  expected_duration_minutes: number;
  expires_at: string;
  remaining_seconds: number;
} | null> {
  const r = await pool.query<{
    id: string;
    started_at: string;
    expected_duration_minutes: number;
    expires_at: string;
    remaining_seconds: number;
  }>(
    `SELECT id,
            started_at,
            expected_duration_minutes,
            (started_at + (expected_duration_minutes || ' minutes')::interval) AS expires_at,
            EXTRACT(EPOCH FROM (
              started_at + (expected_duration_minutes || ' minutes')::interval - NOW()
            ))::int AS remaining_seconds
       FROM "NinoGame".free_pass_periods
      WHERE child_id = $1
        AND ended_at IS NULL
        AND expected_duration_minutes IS NOT NULL
        AND started_at + (expected_duration_minutes || ' minutes')::interval > NOW()
      ORDER BY started_at DESC
      LIMIT 1`,
    [child_id],
  );
  return r.rows[0] ?? null;
}

/** 推 command 到该孩子所有在线 Agent。返回 push 成功数。 */
async function pushToChildAgents(child_id: string, message: object): Promise<number> {
  const devs = await pool.query<{ id: string }>(
    `SELECT d.id FROM "NinoGame".devices d
       JOIN "NinoGame".device_bindings b ON b.device_id = d.id
      WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
    [child_id],
  );
  let pushed = 0;
  for (const d of devs.rows) {
    if (pushToDevice(d.id, message)) pushed++;
  }
  return pushed;
}

export async function registerFreePassRoutes(app: FastifyInstance) {
  // ── 启动 ─────────────────────────────────────────────────
  app.post(
    "/api/free-pass",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const parsed = StartBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { child_id, duration_minutes, reason } = parsed.data;
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }

      // 1) 关掉所有还在活跃中的限免 (新一段覆盖)
      await pool.query(
        `UPDATE "NinoGame".free_pass_periods
            SET ended_at = NOW(), ended_by = 'superseded'
          WHERE child_id = $1 AND ended_at IS NULL`,
        [child_id],
      );

      // 2) 插入新段
      const ins = await pool.query<FreePassRow & { expires_at: string }>(
        `INSERT INTO "NinoGame".free_pass_periods
           (child_id, started_at, expected_duration_minutes, reason, created_by_parent)
         VALUES ($1, NOW(), $2, $3, $4)
         RETURNING id, child_id, started_at, ended_at, expected_duration_minutes, reason, ended_by,
                   (started_at + ($2 || ' minutes')::interval) AS expires_at`,
        [child_id, duration_minutes, reason ?? null, req.parent!.sub],
      );
      const row = ins.rows[0];

      // 3) push 给所有在线 Agent
      const pushed = await pushToChildAgents(child_id, {
        type: "command",
        payload: {
          command_type: "start_free_pass",
          payload: {
            free_pass_id: row.id,
            duration_minutes,
            expires_at: row.expires_at,
            reason: reason ?? null,
          },
        },
      });

      app.log.info(
        { child_id, free_pass_id: row.id, duration_minutes, pushed },
        "free pass started",
      );
      return {
        id: row.id,
        child_id: row.child_id,
        started_at: row.started_at,
        expected_duration_minutes: duration_minutes,
        expires_at: row.expires_at,
        reason: row.reason,
        pushed,
      };
    },
  );

  // ── 结束 ─────────────────────────────────────────────────
  app.post(
    "/api/free-pass/:id/end",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      // 验证归属
      const r0 = await pool.query<{ child_id: string; ended_at: string | null }>(
        `SELECT fp.child_id, fp.ended_at
           FROM "NinoGame".free_pass_periods fp
           JOIN "NinoGame".children c ON c.id = fp.child_id
          WHERE fp.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (r0.rows.length === 0) {
        return reply.notFound("限免记录不存在或不归当前家长");
      }
      const { child_id, ended_at } = r0.rows[0];
      if (ended_at) {
        return reply.badRequest("该限免已结束");
      }

      await pool.query(
        `UPDATE "NinoGame".free_pass_periods
            SET ended_at = NOW(), ended_by = 'parent_manual'
          WHERE id = $1`,
        [id],
      );

      const pushed = await pushToChildAgents(child_id, {
        type: "command",
        payload: {
          command_type: "end_free_pass",
          payload: { free_pass_id: id },
        },
      });

      app.log.info({ child_id, free_pass_id: id, pushed }, "free pass ended manually");
      return { ok: true, pushed };
    },
  );

  // ── 当前活跃 ─────────────────────────────────────────────
  app.get(
    "/api/free-pass/active",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const q = (req.query ?? {}) as Record<string, string>;
      const child_id = q.child_id;
      if (!child_id) return reply.badRequest("child_id required");
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const active = await getActiveFreePass(child_id);
      return { active };
    },
  );

  // ── 历史 (最近 20 段) ─────────────────────────────────────
  app.get(
    "/api/free-pass",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const q = (req.query ?? {}) as Record<string, string>;
      const child_id = q.child_id;
      if (!child_id) return reply.badRequest("child_id required");
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const r = await pool.query<FreePassRow>(
        `SELECT id, child_id, started_at, ended_at,
                expected_duration_minutes, reason, ended_by
           FROM "NinoGame".free_pass_periods
          WHERE child_id = $1
          ORDER BY started_at DESC
          LIMIT 20`,
        [child_id],
      );
      return { periods: r.rows };
    },
  );
}
