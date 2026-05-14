/** /api/admin/daily-summary: 每日总结推送配置.
 *
 * v0.4.8: 关联 services/daily_summary_scheduler (CLAUDE.md §15 + v0.4.7).
 * - GET  返回当前配置 (enabled / time, default {enabled:false, time:"21:00"})
 * - POST 保存配置, 落 admin_settings(key='daily_summary')
 * - POST /trigger 立即跑一次 (忽略时间, 用于测试)
 *
 * 实际投递走 v0.4.1 notifier (企微 + SMTP). 配置不开启时 scheduler 直接 noop.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSetting, putSetting } from "../../services/admin_settings.js";
import { fireSummariesNow, type DailySummaryConfig } from "../../services/daily_summary_scheduler.js";

const Body = z.object({
  enabled: z.boolean().default(false),
  time: z.string().regex(/^\d{2}:\d{2}$/, "时间须 HH:MM 格式 (例 21:00)").default("21:00"),
});

const DEFAULT: DailySummaryConfig = { enabled: false, time: "21:00" };

export async function registerAdminDailySummaryRoutes(app: FastifyInstance) {
  app.get("/api/admin/daily-summary", { preHandler: app.adminAuth }, async () => {
    const v = await getSetting<DailySummaryConfig>("daily_summary");
    return { daily_summary: { ...DEFAULT, ...(v ?? {}) } };
  });

  app.post("/api/admin/daily-summary", { preHandler: app.adminAuth }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    // 进一步校验 time 范围
    const [h, m] = parsed.data.time.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return reply.badRequest("时间须 00:00 — 23:59");
    }
    await putSetting("daily_summary", parsed.data, req.admin!.sub);
    return { daily_summary: parsed.data };
  });

  app.post("/api/admin/daily-summary/trigger", { preHandler: app.adminAuth }, async () => {
    const r = await fireSummariesNow(app.log);
    return r;
  });
}
