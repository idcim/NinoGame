/** /api/admin/llm: LLM 全局配置 CRUD + 连通性 test.
 *
 * v0.4.0+: LLM 配置归 admin 一份, 存 admin_settings(key='llm_config').
 * Parent 端不再有 /llm-config 入口 — 调 LLM 一律走 admin 的配置.
 *
 * 兼容迁移: 启动时如果 admin_settings(key='llm_config') 空 + 老的 llm_config
 * 表第一行非空 → 自动迁移 (写一笔 admin_settings 标 migrated_from_parent_id).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db.js";
import { chat, invalidateCache, maskApiKey, LlmRequestError } from "../../services/llm.js";
import { getSetting, putSetting, deleteSetting } from "../../services/admin_settings.js";

const SaveBody = z.object({
  provider: z.enum(["openai_compatible", "anthropic"]).default("openai_compatible"),
  api_key: z.string().min(1).max(512),
  base_url: z.string().min(8).max(255),
  model: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
});

const TestBody = z.object({
  prompt: z.string().min(1).max(1000).default("Hello, reply with just OK"),
});

interface StoredLlmConfig {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  enabled: boolean;
  updated_at?: string;
  migrated_from_parent_id?: string;
}

export async function registerAdminLlmRoutes(app: FastifyInstance) {
  /** 一次性老数据迁移: 如果 admin_settings 空 + llm_config 表有数据, 复制一笔过来 */
  await migrateFromLegacyTable(app);

  // ── GET 读 (api_key 打码) ────────────────────────────────────
  app.get("/api/admin/llm", { preHandler: app.adminAuth }, async () => {
    const cfg = await getSetting<StoredLlmConfig>("llm_config");
    if (!cfg) return { config: null };
    return {
      config: {
        provider: cfg.provider,
        api_key_masked: maskApiKey(cfg.api_key),
        has_key: cfg.api_key.length > 0,
        base_url: cfg.base_url,
        model: cfg.model,
        enabled: cfg.enabled,
        updated_at: cfg.updated_at,
      },
    };
  });

  // ── 保存 / 更新 ─────────────────────────────────────────────
  app.post("/api/admin/llm", { preHandler: app.adminAuth }, async (req, reply) => {
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const v = parsed.data;
    await putSetting("llm_config", {
      provider: v.provider,
      api_key: v.api_key,
      base_url: v.base_url.replace(/\/+$/, ""),
      model: v.model,
      enabled: v.enabled,
      updated_at: new Date().toISOString(),
    } satisfies StoredLlmConfig, req.admin!.sub);
    invalidateCache();
    return {
      config: {
        provider: v.provider,
        api_key_masked: maskApiKey(v.api_key),
        has_key: true,
        base_url: v.base_url,
        model: v.model,
        enabled: v.enabled,
      },
    };
  });

  // ── 测试连通性 ──────────────────────────────────────────────
  app.post("/api/admin/llm/test", { preHandler: app.adminAuth }, async (req, reply) => {
    const parsed = TestBody.safeParse(req.body || {});
    if (!parsed.success) return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    try {
      const r = await chat([
        { role: "user", content: parsed.data.prompt },
      ], { max_tokens: 50, timeout_ms: 15_000 });
      return { ok: true, reply: r.slice(0, 200) };
    } catch (err) {
      const status = err instanceof LlmRequestError ? err.status : undefined;
      return reply.code(400).send({
        ok: false,
        message: err instanceof Error ? err.message : "未知错误",
        status,
      });
    }
  });

  // ── 删除 ────────────────────────────────────────────────────
  app.delete("/api/admin/llm", { preHandler: app.adminAuth }, async () => {
    await deleteSetting("llm_config");
    invalidateCache();
    return { ok: true };
  });
}

async function migrateFromLegacyTable(app: FastifyInstance) {
  try {
    const existing = await getSetting<StoredLlmConfig>("llm_config");
    if (existing) return; // 已经有 admin 配置
    // 看 legacy llm_config 表是否还在 + 有数据
    const r = await pool.query<{
      parent_id: string;
      provider: string;
      api_key: string;
      base_url: string;
      model: string;
      enabled: boolean;
      updated_at: string;
    }>(
      `SELECT parent_id, provider, api_key, base_url, model, enabled, updated_at
         FROM "NinoGame".llm_config ORDER BY updated_at DESC LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row || !row.api_key) return;
    await pool.query(
      `INSERT INTO "NinoGame".admin_settings (key, value)
       VALUES ('llm_config', $1::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify({
        provider: row.provider,
        api_key: row.api_key,
        base_url: row.base_url,
        model: row.model,
        enabled: row.enabled,
        updated_at: row.updated_at,
        migrated_from_parent_id: row.parent_id,
      })],
    );
    app.log.info({ parent_id: row.parent_id }, "admin: migrated llm_config from legacy parent table");
  } catch (err) {
    // 老表不存在 / 字段不对 都算 OK, 不影响 boot
    app.log.debug({ err }, "admin llm legacy migration skipped");
  }
}
