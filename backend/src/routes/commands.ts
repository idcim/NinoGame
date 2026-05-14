/** /api/commands: 家长向某设备下发 command (临时解锁 / 立即锁定 / etc.)。
 *
 * 行为:
 *   - 验证 device 属于当前家长名下的孩子
 *   - INSERT into commands 表 (status=pending)
 *   - 如果设备 WS 在线, 立刻 push (不等下次 hello)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { pushToDevice } from "../ws/agent.js";

const CreateBody = z.object({
  device_id: z.string().uuid(),
  command_type: z.enum([
    "temporary_unlock",
    "lock_device",
    "start_free_pass",
    "end_free_pass",
    "request_status",
    "set_pin",
    "clear_pin",
    "update_self",
  ]),
  payload: z.record(z.unknown()).default({}),
  expires_in_minutes: z.number().int().min(1).max(1440).optional(),
});

export async function registerCommandRoutes(app: FastifyInstance) {
  app.post("/api/commands", { preHandler: app.parentAuth }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { device_id, command_type, payload, expires_in_minutes } = parsed.data;

    // 验证 device 在当前家长名下 + 取 child_id (后续 normalize 用)
    const owned = await pool.query<{ child_id: string }>(
      `SELECT c.id AS child_id
         FROM "NinoGame".devices d
         JOIN "NinoGame".device_bindings b ON b.device_id = d.id
         JOIN "NinoGame".children c ON c.id = b.child_id
        WHERE d.id = $1 AND c.parent_id = $2
        LIMIT 1`,
      [device_id, req.parent!.sub],
    );
    if (owned.rows.length === 0) {
      return reply.forbidden("设备不属于当前家长名下");
    }
    const child_id = owned.rows[0].child_id;

    // temporary_unlock normalize: 旧前端可能传 rule_id="rule_pvz_all" 这种
    // 硬编码值, 而 server 上规则都是 UUID -> Agent 用此 id 匹配永远 False,
    // 解锁失效。规则: 若 rule_ids 没传 / rule_id 在该孩子 enabled 规则里
    // 找不到, 就 fallback 到该孩子所有 enabled 规则。
    const finalPayload: Record<string, unknown> = { ...payload };
    if (command_type === "temporary_unlock") {
      const raw = payload as { rule_ids?: unknown; rule_id?: unknown };
      const ridsRaw = Array.isArray(raw.rule_ids) ? raw.rule_ids.filter((x) => typeof x === "string") as string[] : undefined;
      const ridRaw = typeof raw.rule_id === "string" ? raw.rule_id : undefined;

      const validRules = await pool.query<{ id: string }>(
        `SELECT id FROM "NinoGame".rules WHERE child_id = $1 AND enabled = TRUE`,
        [child_id],
      );
      const validSet = new Set(validRules.rows.map((r) => r.id));

      let resolved: string[] = [];
      if (ridsRaw && ridsRaw.length > 0) {
        resolved = ridsRaw.filter((x) => validSet.has(x));
      } else if (ridRaw && validSet.has(ridRaw)) {
        resolved = [ridRaw];
      }
      if (resolved.length === 0) {
        // 无 / 找不到 -> 展开为该孩子全部 enabled 规则
        resolved = Array.from(validSet);
        app.log.info(
          { device_id, child_id, requested: ridsRaw ?? ridRaw, fallback_count: resolved.length },
          "temporary_unlock: rule_id fallback 到全部 enabled 规则",
        );
      }
      finalPayload.rule_ids = resolved;
      delete finalPayload.rule_id;  // 不再保留旧字段, 避免 Agent 同时读两边
    }

    const inserted = await pool.query<{ id: string; created_at: string }>(
      `INSERT INTO "NinoGame".commands
         (device_id, command_type, payload, status, expires_at)
       VALUES ($1, $2, $3::jsonb, 'pending',
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE NOW() + ($4::int || ' minutes')::interval END)
       RETURNING id, created_at`,
      [device_id, command_type, JSON.stringify(finalPayload), expires_in_minutes ?? null],
    );
    const cmd = inserted.rows[0];

    // 试推到在线 WS (用 normalize 后的 finalPayload, 不要旧 payload)
    const delivered = pushToDevice(device_id, {
      type: "command",
      id: cmd.id,
      payload: {
        id: cmd.id,
        command_type,
        payload: finalPayload,
      },
    });

    // 实时下发成功 → 标 delivered, 下次 Agent 重连不会再补发同一条
    if (delivered) {
      try {
        await pool.query(
          `UPDATE "NinoGame".commands SET status = 'delivered' WHERE id = $1`,
          [cmd.id],
        );
      } catch (err) {
        app.log.warn({ err, cmd: cmd.id }, "mark delivered after push failed");
      }
    }

    app.log.info(
      { device_id, command_type, delivered },
      delivered
        ? "command pushed to live agent"
        : "command queued (agent offline; will deliver on next hello)",
    );

    return {
      id: cmd.id,
      device_id,
      command_type,
      delivered,
      created_at: cmd.created_at,
    };
  });

  // 列出某设备的命令历史 (家长用)
  app.get(
    "/api/commands",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const q = (req.query ?? {}) as Record<string, string>;
      const device_id = q.device_id;
      if (!device_id) return reply.badRequest("device_id required");
      const r = await pool.query(
        `SELECT c.id, c.command_type, c.payload, c.status, c.expires_at, c.created_at
           FROM "NinoGame".commands c
           JOIN "NinoGame".device_bindings b ON b.device_id = c.device_id
           JOIN "NinoGame".children ch ON ch.id = b.child_id
          WHERE c.device_id = $1 AND ch.parent_id = $2
          ORDER BY c.created_at DESC LIMIT 50`,
        [device_id, req.parent!.sub],
      );
      return { commands: r.rows };
    },
  );
}
