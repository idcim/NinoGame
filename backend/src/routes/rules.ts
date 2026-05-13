/** /api/rules: 规则 CRUD + 变动后立即推 rules_update 给在线 Agent。
 *
 * 表: "NinoGame".rules (id, child_id, name, enabled, spec jsonb)
 *
 * spec 结构 (Agent 的 Rule.from_dict 期望):
 *   {
 *     "matchers": [{field, op, value}, ...],
 *     "matcher_logic": "OR" | "AND",
 *     "exclude_processes": ["chrome.exe", ...],
 *     "schedule": {"mode": "always" | "windowed" | "disabled", "windows": []},
 *     "action": {"type": "kill_and_warn" | "warn_only" | "kill_silent", "message": "..."},
 *     "category_link": "consumption_game",
 *     "notify_parent": true
 *   }
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { pushToDevice } from "../ws/agent.js";

const MatcherSchema = z.object({
  field: z.enum(["process_name", "exe_path", "window_title", "command_line"]),
  op: z.enum(["equals", "iequals", "contains", "icontains", "regex"]),
  value: z.string().min(1).max(255),
});

const SpecSchema = z.object({
  matchers: z.array(MatcherSchema).min(1),
  matcher_logic: z.enum(["OR", "AND"]).default("OR"),
  exclude_processes: z.array(z.string()).default([]),
  schedule: z.object({
    mode: z.enum(["always", "windowed", "disabled"]).default("always"),
    windows: z.array(z.unknown()).default([]),
  }).default({ mode: "always", windows: [] }),
  action: z.object({
    type: z.enum(["kill_and_warn", "warn_only", "kill_silent"]).default("kill_and_warn"),
    message: z.string().max(512).default(""),
  }).default({ type: "kill_and_warn", message: "" }),
  category_link: z.string().optional(),
  notify_parent: z.boolean().default(true),
});

const CreateBody = z.object({
  child_id: z.string().uuid(),
  name: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
  spec: SpecSchema,
});

const UpdateBody = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  spec: SpecSchema.optional(),
});

interface RuleRow {
  id: string;
  child_id: string;
  name: string;
  enabled: boolean;
  spec: unknown;
  updated_at: string;
}

/** 拉孩子的所有 enabled 规则, 推给所有在线 Agent。返回成功推送的设备数。 */
async function pushRulesUpdate(child_id: string): Promise<number> {
  const rules = await pool.query<RuleRow>(
    `SELECT id, name, enabled, spec FROM "NinoGame".rules
      WHERE child_id = $1 AND enabled = TRUE
      ORDER BY updated_at DESC`,
    [child_id],
  );
  const devices = await pool.query<{ id: string }>(
    `SELECT d.id FROM "NinoGame".devices d
       JOIN "NinoGame".device_bindings b ON b.device_id = d.id
      WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
    [child_id],
  );
  let pushed = 0;
  for (const d of devices.rows) {
    if (
      pushToDevice(d.id, {
        type: "rules_update",
        payload: { rules: rules.rows },
      })
    ) {
      pushed++;
    }
  }
  return pushed;
}

async function ensureOwnership(parent_id: string, child_id: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "NinoGame".children WHERE id = $1 AND parent_id = $2`,
    [child_id, parent_id],
  );
  return Number(r.rows[0].count) > 0;
}

export async function registerRuleRoutes(app: FastifyInstance) {
  // ── 列出 (按 child) ──────────────────────────────────────
  app.get(
    "/api/rules",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const q = (req.query ?? {}) as Record<string, string>;
      const child_id = q.child_id;
      if (!child_id) return reply.badRequest("child_id required");
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const r = await pool.query<RuleRow>(
        `SELECT id, child_id, name, enabled, spec, updated_at
           FROM "NinoGame".rules
          WHERE child_id = $1
          ORDER BY updated_at DESC`,
        [child_id],
      );
      return { rules: r.rows };
    },
  );

  // ── 创建 ──────────────────────────────────────────────────
  app.post(
    "/api/rules",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { child_id, name, enabled, spec } = parsed.data;
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const r = await pool.query<RuleRow>(
        `INSERT INTO "NinoGame".rules (child_id, name, enabled, spec)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, child_id, name, enabled, spec, updated_at`,
        [child_id, name, enabled, JSON.stringify(spec)],
      );
      const rule = r.rows[0];
      const pushed = await pushRulesUpdate(child_id);
      app.log.info({ rule_id: rule.id, child_id, pushed }, "rule created");
      return { rule, pushed };
    },
  );

  // ── 更新 ──────────────────────────────────────────────────
  app.put(
    "/api/rules/:id",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      // 验证规则属于当前家长
      const r0 = await pool.query<{ child_id: string }>(
        `SELECT r.child_id FROM "NinoGame".rules r
           JOIN "NinoGame".children c ON c.id = r.child_id
          WHERE r.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (r0.rows.length === 0) return reply.notFound("规则不存在或不归当前家长");
      const child_id = r0.rows[0].child_id;

      const parsed = UpdateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { name, enabled, spec } = parsed.data;
      const r = await pool.query<RuleRow>(
        `UPDATE "NinoGame".rules
            SET name    = COALESCE($2, name),
                enabled = COALESCE($3, enabled),
                spec    = COALESCE($4::jsonb, spec),
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, child_id, name, enabled, spec, updated_at`,
        [id, name ?? null, enabled ?? null, spec ? JSON.stringify(spec) : null],
      );
      const pushed = await pushRulesUpdate(child_id);
      app.log.info({ rule_id: id, child_id, pushed }, "rule updated");
      return { rule: r.rows[0], pushed };
    },
  );

  // ── 删除 ──────────────────────────────────────────────────
  app.delete(
    "/api/rules/:id",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const r0 = await pool.query<{ child_id: string }>(
        `SELECT r.child_id FROM "NinoGame".rules r
           JOIN "NinoGame".children c ON c.id = r.child_id
          WHERE r.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (r0.rows.length === 0) return reply.notFound("规则不存在或不归当前家长");
      const child_id = r0.rows[0].child_id;
      await pool.query(`DELETE FROM "NinoGame".rules WHERE id = $1`, [id]);
      const pushed = await pushRulesUpdate(child_id);
      app.log.info({ rule_id: id, child_id, pushed }, "rule deleted");
      return { ok: true, pushed };
    },
  );
}
