/** /api/llm/*: 家长后台填写 LLM 配置 + 测试连通。
 *
 *   GET    /api/llm/config       脱敏返回当前配置 (api_key 仅显示前 4+后 4)
 *   POST   /api/llm/config       创建/更新配置
 *   POST   /api/llm/test         body {prompt}, 返回 {ok, reply, ms}
 *   DELETE /api/llm/config       删除配置 (回到无 LLM 状态)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  chat,
  deleteConfig,
  getConfig,
  LlmNotConfiguredError,
  LlmRequestError,
  maskApiKey,
  saveConfig,
} from "../services/llm.js";

const SaveBody = z.object({
  provider: z.enum(["openai_compatible", "anthropic"]).default("openai_compatible"),
  api_key: z.string().min(8).max(512),
  base_url: z.string().url().max(256),
  model: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
});

const TestBody = z.object({
  prompt: z.string().min(1).max(2048).default("你好, 一句话介绍你自己。"),
});

export async function registerLlmRoutes(app: FastifyInstance) {
  app.get(
    "/api/llm/config",
    { preHandler: app.parentAuth },
    async (req) => {
      const cfg = await getConfig(req.parent!.sub);
      if (!cfg) return { config: null };
      return {
        config: {
          provider: cfg.provider,
          base_url: cfg.base_url,
          model: cfg.model,
          enabled: cfg.enabled,
          api_key_masked: maskApiKey(cfg.api_key),
          has_key: Boolean(cfg.api_key),
          updated_at: cfg.updated_at,
        },
      };
    },
  );

  app.post(
    "/api/llm/config",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const parsed = SaveBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const saved = await saveConfig({
        parent_id: req.parent!.sub,
        ...parsed.data,
      });
      app.log.info(
        { parent_id: saved.parent_id, provider: saved.provider, base_url: saved.base_url, model: saved.model },
        "llm config saved",
      );
      return {
        config: {
          provider: saved.provider,
          base_url: saved.base_url,
          model: saved.model,
          enabled: saved.enabled,
          api_key_masked: maskApiKey(saved.api_key),
          has_key: true,
          updated_at: saved.updated_at,
        },
      };
    },
  );

  app.post(
    "/api/llm/test",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const parsed = TestBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { prompt } = parsed.data;
      const t0 = Date.now();
      try {
        const reply_text = await chat(
          req.parent!.sub,
          [{ role: "user", content: prompt }],
          { temperature: 0.3, max_tokens: 256, timeout_ms: 30_000 },
        );
        return {
          ok: true,
          reply: reply_text,
          ms: Date.now() - t0,
        };
      } catch (err) {
        if (err instanceof LlmNotConfiguredError) {
          return reply.badRequest(err.message);
        }
        if (err instanceof LlmRequestError) {
          return {
            ok: false,
            reply: "",
            ms: Date.now() - t0,
            error: err.message,
            status: err.status ?? null,
          };
        }
        throw err;
      }
    },
  );

  app.delete(
    "/api/llm/config",
    { preHandler: app.parentAuth },
    async (req) => {
      await deleteConfig(req.parent!.sub);
      return { ok: true };
    },
  );
}
