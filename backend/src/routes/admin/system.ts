/** /api/admin/system: 系统级限额 (download token TTL / max upload / idle lock default)
 *  + 当前存储驱动状态展示.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSetting, putSetting } from "../../services/admin_settings.js";
import { getStorageStatus } from "../../services/storage/factory.js";
import { config } from "../../config.js";

const Body = z.object({
  download_token_ttl_minutes: z.number().int().min(5).max(60 * 24).default(30),
  max_upload_mb: z.number().int().min(10).max(2048).default(300),
  idle_lock_minutes_default: z.number().int().min(1).max(120).default(10),
});

export type AdminSystemConfig = z.infer<typeof Body>;

export async function registerAdminSystemRoutes(app: FastifyInstance) {
  app.get("/api/admin/system", { preHandler: app.adminAuth }, async () => {
    const v = await getSetting<AdminSystemConfig>("system");
    const storage = getStorageStatus();
    return {
      system: v ?? Body.parse({}),
      storage: {
        driver: storage.id,
        configured: storage.configured,
        warning: storage.warning,
        // 暴露非敏感字段, key / secret 全不返
        local: { artifactsDir: config.artifactsDir },
        s3: {
          bucket: config.storageS3.bucket,
          region: config.storageS3.region,
          endpoint: config.storageS3.endpoint || "(default aws)",
        },
        aliyun_oss: {
          bucket: config.storageAliyunOss.bucket,
          region: config.storageAliyunOss.region,
          endpoint: config.storageAliyunOss.endpoint || "(default)",
        },
      },
    };
  });

  app.post("/api/admin/system", { preHandler: app.adminAuth }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    await putSetting("system", parsed.data, req.admin!.sub);
    return { system: parsed.data };
  });
}
