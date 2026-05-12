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
    "request_photo",
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

    // 验证 device 在当前家长名下
    const owned = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM "NinoGame".devices d
         JOIN "NinoGame".device_bindings b ON b.device_id = d.id
         JOIN "NinoGame".children c ON c.id = b.child_id
        WHERE d.id = $1 AND c.parent_id = $2`,
      [device_id, req.parent!.sub],
    );
    if (Number(owned.rows[0].count) === 0) {
      return reply.forbidden("设备不属于当前家长名下");
    }

    const inserted = await pool.query<{ id: string; created_at: string }>(
      `INSERT INTO "NinoGame".commands
         (device_id, command_type, payload, status, expires_at)
       VALUES ($1, $2, $3::jsonb, 'pending',
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE NOW() + ($4::int || ' minutes')::interval END)
       RETURNING id, created_at`,
      [device_id, command_type, JSON.stringify(payload), expires_in_minutes ?? null],
    );
    const cmd = inserted.rows[0];

    // 试推到在线 WS
    const delivered = pushToDevice(device_id, {
      type: "command",
      id: cmd.id,
      payload: {
        id: cmd.id,
        command_type,
        payload,
      },
    });

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
