/** /api/unlock-requests: 家长审批流。
 *
 * 流程:
 *   1) Agent 通过 WS 发 {type:"unlock_request", payload:{request_text, child_id, ...}}
 *      → backend onUnlockRequest 写 unlock_requests 表 + 推 parent bus
 *   2) 家长浏览器 GET /api/unlock-requests?status=pending 列出待审
 *   3) POST /api/unlock-requests/:id/approve {duration_minutes, rule_id}
 *      → 写 commands 表 + push 给 Agent + 标记 status=approved
 *   4) POST /api/unlock-requests/:id/reject {comment?}
 *      → 标记 status=rejected, Agent 端收到也能展示
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { translateUnlockRequest } from "../services/llm_request_translator.js";
import { recomputeTrust } from "../services/trust.js";
import { pushToDevice } from "../ws/agent.js";
import { publishToParent } from "../ws/event_bus.js";

// rule_id 已废弃: 旧前端可能传 "rule_pvz_all" 这种硬编码值,
// server 上规则用 UUID 永远对不上 -> 放行失效。
// 新逻辑: 不再依赖前端传规则, server 自己展开为"该孩子全部 enabled 规则"。
const ApproveBody = z.object({
  duration_minutes: z.number().int().min(1).max(1440),
  rule_id: z.string().min(1).max(64).optional(),  // 兼容老前端 (忽略)
  comment: z.string().max(512).optional(),
});

const RejectBody = z.object({
  comment: z.string().max(512).optional(),
});

interface RequestRow {
  id: string;
  child_id: string;
  request_text: string;
  structured_request: unknown;
  llm_summary: string | null;
  status: string;
  parent_decision_at: string | null;
  parent_comment: string | null;
  created_at: string;
}

/** Agent WS 触发 (从 ws/agent.ts 调) — 创建请求 + 推家长 bus。 */
export async function createUnlockRequestFromAgent(
  app: FastifyInstance,
  child_id: string,
  device_id: string,
  request_text: string,
  structured: Record<string, unknown> = {},
): Promise<RequestRow | null> {
  if (!child_id || !request_text) return null;
  try {
    const r = await pool.query<RequestRow>(
      `INSERT INTO "NinoGame".unlock_requests
         (child_id, request_text, structured_request, status)
       VALUES ($1, $2, $3::jsonb, 'pending')
       RETURNING id, child_id, request_text, structured_request, llm_summary,
                 status, parent_decision_at, parent_comment, created_at`,
      [child_id, request_text, JSON.stringify(structured)],
    );
    const row = r.rows[0];

    // 查 parent_id 推给家长浏览器
    const pq = await pool.query<{ parent_id: string }>(
      `SELECT parent_id FROM "NinoGame".children WHERE id = $1`,
      [child_id],
    );
    const parent_id = pq.rows[0]?.parent_id;
    if (parent_id) {
      publishToParent({
        parent_id,
        child_id,
        device_id,
        event_type: "unlock_request",
        payload: {
          request_id: row.id,
          request_text,
          structured,
        },
        occurred_at: row.created_at,
      });

      // 异步 LLM 翻译: 不阻塞 Agent 那边的 WS 响应; 拿到结果再 UPDATE +
      // 二次 publishToParent 让浏览器实时刷新摘要 (§12.2 / §13.1)
      void (async () => {
        try {
          const t = await translateUnlockRequest(request_text);
          if (!t) return;
          await pool.query(
            `UPDATE "NinoGame".unlock_requests
                SET structured_request = $2::jsonb,
                    llm_summary = $3
              WHERE id = $1`,
            [row.id, JSON.stringify(t), t.summary],
          );
          publishToParent({
            parent_id,
            child_id,
            device_id,
            event_type: "unlock_request_translated",
            payload: {
              request_id: row.id,
              llm_summary: t.summary,
              structured: t,
            },
            occurred_at: new Date().toISOString(),
          });
          app.log.info(
            { request_id: row.id, duration: t.duration_minutes, activity: t.activity },
            "unlock_request LLM translated",
          );
        } catch (err) {
          app.log.warn({ err, request_id: row.id }, "translate unlock_request failed");
        }
      })();
    }
    app.log.info({ child_id, request_id: row.id }, "unlock_request created");
    return row;
  } catch (err) {
    app.log.warn({ err, child_id }, "create unlock_request failed");
    return null;
  }
}

export async function registerUnlockRequestRoutes(app: FastifyInstance) {
  // ── 列出 (默认 pending) ────────────────────────────────────
  app.get(
    "/api/unlock-requests",
    { preHandler: app.parentAuth },
    async (req) => {
      const q = (req.query ?? {}) as Record<string, string>;
      const status = q.status || "pending";
      const r = await pool.query<RequestRow & { child_username: string }>(
        `SELECT ur.*, c.username AS child_username, c.display_name
           FROM "NinoGame".unlock_requests ur
           JOIN "NinoGame".children c ON c.id = ur.child_id
          WHERE c.parent_id = $1
            AND ($2 = 'all' OR ur.status = $2)
          ORDER BY ur.created_at DESC LIMIT 100`,
        [req.parent!.sub, status],
      );
      return { requests: r.rows };
    },
  );

  // ── 批准: 写 commands + push + 标记 ────────────────────
  app.post(
    "/api/unlock-requests/:id/approve",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = ApproveBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { duration_minutes, comment } = parsed.data;

      // 验证归属 + 拿 child_id
      const rq = await pool.query<{ id: string; child_id: string; status: string }>(
        `SELECT ur.id, ur.child_id, ur.status FROM "NinoGame".unlock_requests ur
           JOIN "NinoGame".children c ON c.id = ur.child_id
          WHERE ur.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (rq.rows.length === 0) return reply.notFound("请求不存在或不归当前家长");
      const child_id = rq.rows[0].child_id;
      if (rq.rows[0].status !== "pending") {
        return reply.conflict(`请求已处理 (status=${rq.rows[0].status})`);
      }

      // 查该孩子所有 enabled 规则的 UUID, 一次性放行全部 (孩子说"想玩游戏"
      // 通常就是希望所有被拦截的游戏都解锁; 不让家长在 UI 上挑哪条)
      const rulesQ = await pool.query<{ id: string }>(
        `SELECT id FROM "NinoGame".rules
          WHERE child_id = $1 AND enabled = TRUE`,
        [child_id],
      );
      const rule_ids = rulesQ.rows.map((r) => r.id);
      if (rule_ids.length === 0) {
        app.log.warn({ child_id, request_id: id }, "approve: 该孩子没有 enabled 规则可放行");
      }

      // 找该孩子在线的设备 (能挑某一台或全推; 这里全推)
      const devs = await pool.query<{ id: string }>(
        `SELECT d.id FROM "NinoGame".devices d
           JOIN "NinoGame".device_bindings b ON b.device_id = d.id
          WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
        [child_id],
      );

      let pushed_to = 0;
      let last_cmd_id: string | null = null;
      for (const dev of devs.rows) {
        const payload = {
          rule_ids,
          duration_seconds: duration_minutes * 60,
        };
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO "NinoGame".commands
             (device_id, command_type, payload, status, expires_at)
           VALUES ($1, 'temporary_unlock', $2::jsonb, 'pending', NOW() + INTERVAL '24 hours')
           RETURNING id`,
          [dev.id, JSON.stringify(payload)],
        );
        last_cmd_id = ins.rows[0].id;
        const livePushed = pushToDevice(dev.id, {
          type: "command",
          id: ins.rows[0].id,
          payload: {
            id: ins.rows[0].id,
            command_type: "temporary_unlock",
            payload,
          },
        });
        if (livePushed) {
          pushed_to++;
          // 实时推过去 → 标 delivered, 下次重连不再重复
          await pool.query(
            `UPDATE "NinoGame".commands SET status = 'delivered' WHERE id = $1`,
            [ins.rows[0].id],
          );
        }
      }

      // 标记请求状态
      const updated = await pool.query<RequestRow>(
        `UPDATE "NinoGame".unlock_requests
            SET status = 'approved',
                parent_decision_at = NOW(),
                parent_comment = $2
          WHERE id = $1
          RETURNING *`,
        [id, comment ?? null],
      );

      app.log.info(
        { request_id: id, child_id, duration_minutes, pushed_to, cmd: last_cmd_id },
        "unlock_request approved",
      );

      // 信任值重算 (异步, 不阻塞响应)
      void recomputeTrust(child_id).then((tr) => {
        if (tr.changed) {
          app.log.info({ child_id, ...tr }, "trust level changed");
        }
      }).catch((err) => {
        app.log.warn({ err, child_id }, "recomputeTrust failed");
      });

      return {
        request: updated.rows[0],
        pushed_to,
        command_id: last_cmd_id,
      };
    },
  );

  // ── 拒绝 ────────────────────────────────────────────────
  app.post(
    "/api/unlock-requests/:id/reject",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = RejectBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest("请求体格式错误");
      }
      const { comment } = parsed.data;
      const rq = await pool.query<{ id: string; child_id: string; status: string }>(
        `SELECT ur.id, ur.child_id, ur.status FROM "NinoGame".unlock_requests ur
           JOIN "NinoGame".children c ON c.id = ur.child_id
          WHERE ur.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (rq.rows.length === 0) return reply.notFound("请求不存在");
      if (rq.rows[0].status !== "pending") {
        return reply.conflict(`请求已处理 (status=${rq.rows[0].status})`);
      }
      const updated = await pool.query<RequestRow>(
        `UPDATE "NinoGame".unlock_requests
            SET status = 'rejected',
                parent_decision_at = NOW(),
                parent_comment = $2
          WHERE id = $1
          RETURNING *`,
        [id, comment ?? null],
      );
      app.log.info({ request_id: id }, "unlock_request rejected");
      void recomputeTrust(rq.rows[0].child_id).then((tr) => {
        if (tr.changed) {
          app.log.info({ child_id: rq.rows[0].child_id, ...tr }, "trust level changed");
        }
      }).catch((err) => {
        app.log.warn({ err }, "recomputeTrust failed");
      });
      return { request: updated.rows[0] };
    },
  );
}
