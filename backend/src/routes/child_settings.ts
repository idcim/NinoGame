/** /api/children/:id/settings: 家长后台编辑 Agent 设置, 写完即时推 Agent。 */
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import {
  getMergedSettings,
  getRawSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type ChildSettings,
} from "../services/child_settings.js";
import { pushToDevice } from "../ws/agent.js";

async function ensureOwnership(parent_id: string, child_id: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "NinoGame".children
      WHERE id = $1 AND parent_id = $2`,
    [child_id, parent_id],
  );
  return Number(r.rows[0].count) > 0;
}

async function pushSettingsToAgent(child_id: string, merged: ChildSettings): Promise<number> {
  const devs = await pool.query<{ id: string }>(
    `SELECT d.id FROM "NinoGame".devices d
       JOIN "NinoGame".device_bindings b ON b.device_id = d.id
      WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
    [child_id],
  );
  let pushed = 0;
  for (const d of devs.rows) {
    if (pushToDevice(d.id, {
      type: "settings_update",
      payload: { settings: merged },
    })) pushed++;
  }
  return pushed;
}

export async function registerChildSettingsRoutes(app: FastifyInstance) {
  // GET: 返回 merged (含默认) + raw (仅家长改过的字段) + defaults
  app.get(
    "/api/children/:id/settings",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const [merged, raw] = await Promise.all([
        getMergedSettings(child_id),
        getRawSettings(child_id),
      ]);
      return {
        merged,
        raw,
        defaults: DEFAULT_SETTINGS,
      };
    },
  );

  // PUT: partial merge, 写完推 Agent
  app.put(
    "/api/children/:id/settings",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const body = (req.body ?? {}) as Partial<ChildSettings>;
      if (typeof body !== "object" || body === null) {
        return reply.badRequest("body 必须是 object");
      }
      const { merged, raw } = await saveSettings(child_id, body);
      const pushed = await pushSettingsToAgent(child_id, merged);
      app.log.info(
        { child_id, pushed, keys: Object.keys(body) },
        "child_settings updated",
      );
      return { merged, raw, pushed };
    },
  );

  // POST /reset: 清空 raw, 全部回到默认
  app.post(
    "/api/children/:id/settings/reset",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      await pool.query(
        `DELETE FROM "NinoGame".child_settings WHERE child_id = $1`,
        [child_id],
      );
      const { invalidateCache } = await import("../services/child_settings.js");
      invalidateCache(child_id);
      const merged = await getMergedSettings(child_id);
      const pushed = await pushSettingsToAgent(child_id, merged);
      return { merged, raw: {}, pushed };
    },
  );
}
