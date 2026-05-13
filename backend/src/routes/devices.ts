import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { pool } from "../db.js";
import { getConnectedDevices } from "../ws/agent.js";

// 配对码: 8 个大写字母 + 数字, 排除易混 (0/O, I/1)
const PAIR_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_CODE_LEN = 8;
const PAIR_CODE_TTL_MINUTES = 30;

function generatePairCode(): string {
  let out = "";
  for (let i = 0; i < PAIR_CODE_LEN; i++) {
    out += PAIR_CODE_CHARS[randomBytes(1)[0] % PAIR_CODE_CHARS.length];
  }
  return out;
}

function generateAgentToken(): string {
  // 256-bit 随机, base64url 大概 43 字符
  return randomBytes(32).toString("base64url");
}

const PairCreateBody = z.object({
  child_id: z.string().uuid(),
  device_type: z.enum(["child_primary", "parent_primary", "shared"]).optional(),
  name: z.string().max(128).optional(),
});

const RedeemBody = z.object({
  code: z.string().length(PAIR_CODE_LEN),
  platform: z.enum(["windows", "android", "macos", "linux"]).default("windows"),
  os_info: z.record(z.unknown()).optional(),
});

interface DeviceRow {
  id: string;
  device_type: string;
  default_mode: string;
  idle_lock_minutes: number;
  name: string | null;
  pairing_code: string | null;
  agent_token: string | null;
  os_info: unknown;
  platform: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export async function registerDeviceRoutes(app: FastifyInstance) {
  // ── 家长: 生成配对码 ───────────────────────────────────
  app.post(
    "/api/devices/pair",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const parsed = PairCreateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      }
      const { child_id, device_type, name } = parsed.data;

      // 验证孩子属于这个家长
      const ownCheck = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM "NinoGame".children WHERE id = $1 AND parent_id = $2',
        [child_id, req.parent!.sub],
      );
      if (Number(ownCheck.rows[0].count) === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }

      const code = generatePairCode();
      const r = await pool.query<DeviceRow>(
        `INSERT INTO "NinoGame".devices
          (device_type, default_mode, idle_lock_minutes, name, pairing_code, platform)
         VALUES (COALESCE($1, 'child_primary'),
                 'auto_child', 10, $2, $3, NULL)
         RETURNING *`,
        [device_type ?? null, name ?? null, code],
      );

      // 记 binding 待审核 (or 直接绑定); 这里直接 binding, 等 redeem 时验证 code
      await pool.query(
        `INSERT INTO "NinoGame".device_bindings (device_id, child_id) VALUES ($1, $2)`,
        [r.rows[0].id, child_id],
      );

      return {
        device_id: r.rows[0].id,
        pairing_code: code,
        expires_in_minutes: PAIR_CODE_TTL_MINUTES,
        instructions: `在 Agent 设备运行 set_pair_code.py 输入此 8 位码`,
      };
    },
  );

  // ── Agent: 用配对码兑换 agent_token ───────────────────
  app.post("/api/devices/pair/redeem", async (req, reply) => {
    const parsed = RedeemBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(
        parsed.error.issues.map((i) => i.message).join("; "),
      );
    }
    const { code, platform, os_info } = parsed.data;

    // 找未过期 + 未兑换的设备
    const r = await pool.query<DeviceRow & { binding_child: string | null }>(
      `SELECT d.*, b.child_id AS binding_child
         FROM "NinoGame".devices d
         LEFT JOIN "NinoGame".device_bindings b ON b.device_id = d.id
        WHERE d.pairing_code = $1
          AND d.agent_token IS NULL
          AND d.created_at > NOW() - INTERVAL '${PAIR_CODE_TTL_MINUTES} minutes'
        LIMIT 1`,
      [code],
    );
    const dev = r.rows[0];
    if (!dev) {
      return reply.notFound("配对码无效或已过期");
    }

    const token = generateAgentToken();
    const updated = await pool.query<DeviceRow>(
      `UPDATE "NinoGame".devices
         SET agent_token = $1,
             pairing_code = NULL,
             platform = $2,
             os_info = $3,
             last_seen_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [token, platform, os_info ?? null, dev.id],
    );

    return {
      agent_token: token,
      device_id: updated.rows[0].id,
      child_id: dev.binding_child,
    };
  });

  // ── 家长: 列出自己孩子的设备 ──────────────────────────
  app.get(
    "/api/devices",
    { preHandler: app.parentAuth },
    async (req) => {
      const r = await pool.query<{
        id: string; device_type: string; name: string | null;
        platform: string | null; last_seen_at: string | null;
        created_at: string; paired: boolean; child_id: string | null;
      }>(
        `SELECT d.id, d.device_type, d.name, d.platform, d.last_seen_at,
                d.created_at,
                CASE WHEN d.agent_token IS NULL THEN false ELSE true END AS paired,
                b.child_id
           FROM "NinoGame".devices d
           LEFT JOIN "NinoGame".device_bindings b ON b.device_id = d.id
          WHERE b.child_id IN (
            SELECT id FROM "NinoGame".children WHERE parent_id = $1
          )
          ORDER BY d.created_at DESC`,
        [req.parent!.sub],
      );
      const online = new Set(getConnectedDevices().map((c) => c.device_id));
      return {
        devices: r.rows.map((d) => ({ ...d, online: online.has(d.id) })),
      };
    },
  );

  // ── 在线历史 (最近 N 段) ───────────────────────────────
  app.get(
    "/api/devices/:id/online-history",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "NinoGame".devices d
           JOIN "NinoGame".device_bindings b ON b.device_id = d.id
           JOIN "NinoGame".children c ON c.id = b.child_id
          WHERE d.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("设备不属于当前家长");
      }
      const r = await pool.query(
        `SELECT id, connected_at, disconnected_at, duration_seconds, remote_ip
           FROM "NinoGame".device_online_sessions
          WHERE device_id = $1
          ORDER BY connected_at DESC
          LIMIT 50`,
        [id],
      );
      // 今天总时长
      const t = await pool.query<{ total_seconds: string }>(
        `SELECT COALESCE(SUM(
                  COALESCE(duration_seconds,
                           EXTRACT(EPOCH FROM (NOW() - connected_at))::int)
                ), 0)::text AS total_seconds
           FROM "NinoGame".device_online_sessions
          WHERE device_id = $1
            AND connected_at::date = CURRENT_DATE`,
        [id],
      );
      return {
        sessions: r.rows,
        today_total_seconds: Number(t.rows[0].total_seconds),
      };
    },
  );

  // ── 重新生成配对码: 作废旧 agent_token + 给新码 ─────────────
  app.post(
    "/api/devices/:id/regenerate-pair",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      // 验证设备归属
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "NinoGame".devices d
           JOIN "NinoGame".device_bindings b ON b.device_id = d.id
           JOIN "NinoGame".children c ON c.id = b.child_id
          WHERE d.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("设备不属于当前家长");
      }

      const code = generatePairCode();
      const r = await pool.query<{ id: string; pairing_code: string }>(
        `UPDATE "NinoGame".devices
            SET pairing_code = $1,
                agent_token = NULL,
                last_seen_at = NULL,
                created_at = NOW()
          WHERE id = $2
          RETURNING id, pairing_code`,
        [code, id],
      );

      app.log.info({ device_id: id }, "device pair code regenerated (old token revoked)");
      return {
        device_id: r.rows[0].id,
        pairing_code: r.rows[0].pairing_code,
        expires_in_minutes: PAIR_CODE_TTL_MINUTES,
        note: "旧 agent_token 已作废, Agent 必须用新码重新配对",
      };
    },
  );

  // ── 删除设备 ────────────────────────────────────────────
  app.delete(
    "/api/devices/:id",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      // 验证归属
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "NinoGame".devices d
           LEFT JOIN "NinoGame".device_bindings b ON b.device_id = d.id
           LEFT JOIN "NinoGame".children c ON c.id = b.child_id
          WHERE d.id = $1 AND (c.parent_id = $2 OR c.id IS NULL)`,
        [id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("设备不属于当前家长");
      }
      // CASCADE: device_bindings 已配 ON DELETE CASCADE 自动清
      await pool.query(`DELETE FROM "NinoGame".devices WHERE id = $1`, [id]);
      app.log.info({ device_id: id }, "device deleted");
      return { ok: true };
    },
  );
}

/** 给 WS handler 用: 通过 agent_token 找设备。返回 null 表示无效。 */
export async function lookupDeviceByToken(token: string): Promise<{
  device_id: string;
  child_id: string | null;
} | null> {
  const r = await pool.query<{ id: string; child_id: string | null }>(
    `SELECT d.id, b.child_id
       FROM "NinoGame".devices d
       LEFT JOIN "NinoGame".device_bindings b ON b.device_id = d.id
      WHERE d.agent_token = $1
      LIMIT 1`,
    [token],
  );
  if (r.rows.length === 0) return null;
  return { device_id: r.rows[0].id, child_id: r.rows[0].child_id };
}
