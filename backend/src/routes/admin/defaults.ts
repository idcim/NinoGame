/** /api/admin/defaults: 新建 child 默认值 + 默认规则 seed.
 *
 * 存 admin_settings(key='defaults'). children.ts 新建时读这里;
 * default_rules.ts 给孤立 child seed 时读这里.
 *
 * 不直接落 children / rules 表 — 仅作为新 child 的"出厂设置".
 * 现有 child 不动 (家长各自 customize 过的 maturity/quota 不被覆盖).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSetting, putSetting } from "../../services/admin_settings.js";

const RuleSpecForSeed = z.object({
  name: z.string().min(1).max(128),
  keywords: z.array(z.string().min(1).max(64)).min(1).max(20),
  action: z.enum(["kill_and_warn", "warn_only", "kill_silent"]).default("kill_and_warn"),
  message: z.string().max(512).default(""),
});

const Body = z.object({
  maturity_mode: z.enum(["strict", "negotiable", "advisory", "self_regulated"]).default("negotiable"),
  quota_package: z.enum(["tight", "balanced", "task_driven", "trust", "custom"]).default("balanced"),
  default_rules: z.array(RuleSpecForSeed).max(50).default([]),
});

export type AdminDefaults = z.infer<typeof Body>;

export async function registerAdminDefaultsRoutes(app: FastifyInstance) {
  app.get("/api/admin/defaults", { preHandler: app.adminAuth }, async () => {
    const v = await getSetting<AdminDefaults>("defaults");
    return {
      defaults: v ?? {
        maturity_mode: "negotiable",
        quota_package: "balanced",
        default_rules: [
          {
            name: "PvZ 全家桶",
            keywords: ["plantsvszombies", "popcapgame1", "植物大战僵尸"],
            action: "kill_and_warn",
            message: "PvZ 还没被授权使用, 先和家长沟通。",
          },
        ],
      },
    };
  });

  app.post("/api/admin/defaults", { preHandler: app.adminAuth }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    await putSetting("defaults", parsed.data, req.admin!.sub);
    return { defaults: parsed.data };
  });
}
