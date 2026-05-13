/** LLM 服务: 支持任意 OpenAI-compatible API + Anthropic messages API。
 *
 * 设计:
 *   - 多数主流 LLM (OpenAI / DeepSeek / Qwen DashScope-compat / Moonshot / GLM 等)
 *     都兼容 OpenAI /v1/chat/completions, 只需 base_url + api_key + model.
 *   - Anthropic claude 走 /v1/messages 单独路径 (auth header 也不同).
 *   - 用原生 fetch, 不引外部 SDK (减少依赖体积).
 *   - 60s LRU 配置 cache 避免每次 DB 查.
 *
 * 使用入口: chat(parent_id, messages[, options]) → string
 *   家长申请翻译 / app 分类 / 反思摘要 等场景调它, 拿配置失败/未启用就抛
 *   LlmNotConfiguredError, 调用方降级到无 LLM 行为。
 */
import { pool } from "../db.js";

export interface LlmConfig {
  parent_id: string;
  provider: string;        // 'openai_compatible' | 'anthropic'
  api_key: string;
  base_url: string;        // 含 /v1
  model: string;
  enabled: boolean;
  updated_at: string;
}

export class LlmNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmNotConfiguredError";
  }
}

export class LlmRequestError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "LlmRequestError";
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

// 简易 LRU: 单进程内存 cache
const _cache = new Map<string, { config: LlmConfig | null; expires_at: number }>();
const CACHE_TTL_MS = 60_000;

export function invalidateCache(parent_id: string): void {
  _cache.delete(parent_id);
}

export async function getConfig(parent_id: string): Promise<LlmConfig | null> {
  const c = _cache.get(parent_id);
  if (c && c.expires_at > Date.now()) return c.config;
  const r = await pool.query<LlmConfig>(
    `SELECT parent_id, provider, api_key, base_url, model, enabled, updated_at
       FROM "NinoGame".llm_config WHERE parent_id = $1`,
    [parent_id],
  );
  const cfg = r.rows[0] ?? null;
  _cache.set(parent_id, { config: cfg, expires_at: Date.now() + CACHE_TTL_MS });
  return cfg;
}

export async function saveConfig(input: {
  parent_id: string;
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  enabled?: boolean;
}): Promise<LlmConfig> {
  const r = await pool.query<LlmConfig>(
    `INSERT INTO "NinoGame".llm_config
       (parent_id, provider, api_key, base_url, model, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (parent_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       api_key = EXCLUDED.api_key,
       base_url = EXCLUDED.base_url,
       model = EXCLUDED.model,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()
     RETURNING parent_id, provider, api_key, base_url, model, enabled, updated_at`,
    [
      input.parent_id,
      input.provider,
      input.api_key,
      input.base_url,
      input.model,
      input.enabled ?? true,
    ],
  );
  invalidateCache(input.parent_id);
  return r.rows[0];
}

export async function deleteConfig(parent_id: string): Promise<void> {
  await pool.query(
    `DELETE FROM "NinoGame".llm_config WHERE parent_id = $1`,
    [parent_id],
  );
  invalidateCache(parent_id);
}

/** 主入口: 给定家长 + messages, 返回 LLM 文本回复。
 *  失败抛 LlmNotConfiguredError / LlmRequestError, 调用方自决降级。
 */
export async function chat(
  parent_id: string,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const cfg = await getConfig(parent_id);
  if (!cfg || !cfg.enabled) {
    throw new LlmNotConfiguredError(
      cfg ? "LLM 已配置但未启用" : "LLM 未配置 (家长后台 /llm-config 设置)",
    );
  }
  if (cfg.provider === "anthropic") {
    return chatAnthropic(cfg, messages, options);
  }
  // 默认 / openai_compatible: 任意兼容 OpenAI /v1/chat/completions 的服务
  return chatOpenAiCompatible(cfg, messages, options);
}

async function chatOpenAiCompatible(
  cfg: LlmConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<string> {
  const url = cfg.base_url.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: cfg.model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? 512,
    stream: false,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout_ms ?? 30_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new LlmRequestError(
        `LLM HTTP ${resp.status}: ${text.slice(0, 200)}`,
        resp.status,
      );
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LlmRequestError("LLM 返回不含 choices[0].message.content");
    }
    return content.trim();
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LlmRequestError(`LLM 超时 (${options.timeout_ms ?? 30000}ms)`);
    }
    throw new LlmRequestError(
      err instanceof Error ? err.message : "LLM 调用未知错误",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function chatAnthropic(
  cfg: LlmConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<string> {
  // Anthropic messages API: system 单独字段, 其它消息走 messages 数组
  const system = messages.find((m) => m.role === "system")?.content;
  const userMsgs = messages.filter((m) => m.role !== "system");
  const url = cfg.base_url.replace(/\/+$/, "") + "/messages";
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: userMsgs.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: options.max_tokens ?? 512,
    temperature: options.temperature ?? 0.3,
  };
  if (system) body.system = system;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout_ms ?? 30_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new LlmRequestError(
        `LLM HTTP ${resp.status}: ${text.slice(0, 200)}`,
        resp.status,
      );
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") {
      throw new LlmRequestError("Anthropic 返回不含 content[type=text].text");
    }
    return text.trim();
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LlmRequestError(`LLM 超时 (${options.timeout_ms ?? 30000}ms)`);
    }
    throw new LlmRequestError(
      err instanceof Error ? err.message : "Anthropic 调用未知错误",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** API 端点用: 隐藏 api_key 中间, 仅显示前 4 + 后 4. */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "****" + key.slice(-2);
  return key.slice(0, 4) + "****" + key.slice(-4);
}
