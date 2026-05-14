/** /api/admin/push: 推送通道配置 (企微 webhook / SMTP).
 *
 * v0.4.0 仅做配置 UI + 落库 admin_settings(key='push').
 * 真正发送实现 (notifier) 留 P5; 落数据后调用方调 getPushConfig() 用.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSetting, putSetting } from "../../services/admin_settings.js";

const Body = z.object({
  wechat_work: z.object({
    enabled: z.boolean().default(false),
    webhook_url: z.string().max(512).default(""),
  }).default({ enabled: false, webhook_url: "" }),
  smtp: z.object({
    enabled: z.boolean().default(false),
    host: z.string().max(255).default(""),
    port: z.number().int().min(1).max(65535).default(465),
    secure: z.boolean().default(true),
    user: z.string().max(255).default(""),
    password: z.string().max(255).default(""),
    from: z.string().max(255).default(""),
  }).default({
    enabled: false, host: "", port: 465, secure: true,
    user: "", password: "", from: "",
  }),
});

export type AdminPushConfig = z.infer<typeof Body>;

function mask(v: AdminPushConfig): AdminPushConfig {
  return {
    ...v,
    smtp: {
      ...v.smtp,
      password: v.smtp.password ? "****" : "",
    },
  };
}

export async function registerAdminPushRoutes(app: FastifyInstance) {
  app.get("/api/admin/push", { preHandler: app.adminAuth }, async () => {
    const v = await getSetting<AdminPushConfig>("push");
    return { push: v ? mask(v) : mask(Body.parse({})) };
  });

  app.post("/api/admin/push", { preHandler: app.adminAuth }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    // smtp.password 显式留空表示"保持原样"
    const v = parsed.data;
    if (v.smtp.password === "" || v.smtp.password === "****") {
      const existing = await getSetting<AdminPushConfig>("push");
      if (existing?.smtp.password) {
        v.smtp.password = existing.smtp.password;
      }
    }
    await putSetting("push", v, req.admin!.sub);
    return { push: mask(v) };
  });
}
