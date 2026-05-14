/** Admin API client.
 *
 * 所有调用走 Bearer admin token (localStorage.ninogame.admin.token).
 * 跟 parent frontend 完全隔离 — token 不复用, 走独立 /auth/admin/* /api/admin/* 端点.
 */
import { clearAuth, getToken } from "./auth";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  auth = true,
): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (auth) {
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const resp = await fetch(path, { ...init, headers });
  if (resp.status === 401) {
    clearAuth();
    throw new ApiError(401, "未登录或登录已过期");
  }
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.message) msg = data.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, msg);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

// ── types ────────────────────────────────────────────────────────
export interface AdminInfo {
  id: string;
  username: string;
  display_name: string | null;
  created_at?: string;
}

export interface AuthResp {
  token: string;
  admin: AdminInfo;
}

export interface LlmConfigMasked {
  provider: "openai_compatible" | "anthropic";
  api_key_masked: string;
  has_key: boolean;
  base_url: string;
  model: string;
  enabled: boolean;
  updated_at?: string;
}

export interface AgentRelease {
  id: string;
  version: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  is_target: boolean;
  notes: string | null;
  uploaded_at: string;
}

export interface AppCategoryRow {
  id: string;
  app_identifier: string;
  category: "consumption" | "productive" | "neutral";
  sub_type: string | null;
  display_name: string | null;
  rate_multiplier: number;
  classification_source: string;
  created_at: string;
}

export interface RuleSeed {
  name: string;
  keywords: string[];
  action: "kill_and_warn" | "warn_only" | "kill_silent";
  message: string;
}

export interface AdminDefaults {
  maturity_mode: "strict" | "negotiable" | "advisory" | "self_regulated";
  quota_package: "tight" | "balanced" | "task_driven" | "trust" | "custom";
  default_rules: RuleSeed[];
}

export interface AdminSystemView {
  system: {
    download_token_ttl_minutes: number;
    max_upload_mb: number;
    idle_lock_minutes_default: number;
  };
  storage: {
    driver: "local" | "s3" | "aliyun_oss";
    configured: boolean;
    warning: string | null;
    local: { artifactsDir: string };
    s3: { bucket: string; region: string; endpoint: string };
    aliyun_oss: { bucket: string; region: string; endpoint: string };
  };
}

export interface AdminDailySummaryConfig {
  enabled: boolean;
  time: string; // "HH:MM"
}

export interface AdminPushConfig {
  wechat_work: { enabled: boolean; webhook_url: string };
  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;     // 后端返回 "****" 或 ""
    from: string;
  };
}

export interface TenantRow {
  id: string;
  username: string;
  tenant_id: string | null;
  created_at: string;
  child_count: number;
  device_count: number;
  last_seen: string | null;
}

// ── api object ───────────────────────────────────────────────────
export const api = {
  // auth
  login: (username: string, password: string) =>
    request<AuthResp>("/auth/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }, false),
  me: () => request<{ admin: AdminInfo | null }>("/auth/admin/me"),

  // LLM
  getLlm: () => request<{ config: LlmConfigMasked | null }>("/api/admin/llm"),
  saveLlm: (data: {
    provider: "openai_compatible" | "anthropic";
    api_key: string;
    base_url: string;
    model: string;
    enabled?: boolean;
  }) =>
    request<{ config: LlmConfigMasked }>("/api/admin/llm", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** test 在 LLM 错误时后端返 400 含结构化 body, 这里手动 fetch 不走 request 抛 ApiError. */
  async testLlm(prompt?: string): Promise<{ ok: boolean; reply: string; ms: number; error?: string; status?: number }> {
    const token = getToken();
    const resp = await fetch("/api/admin/llm/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(prompt ? { prompt } : {}),
    });
    if (resp.status === 401) { clearAuth(); throw new ApiError(401, "未登录或登录已过期"); }
    return resp.json();
  },
  deleteLlm: () => request<{ ok: boolean }>("/api/admin/llm", { method: "DELETE" }),

  // Releases
  listReleases: () => request<{ releases: AgentRelease[] }>("/api/admin/releases"),
  async uploadRelease(file: File, version: string, notes: string = ""): Promise<{ release: AgentRelease }> {
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("version", version);
    if (notes) fd.append("notes", notes);
    const token = getToken();
    const resp = await fetch("/api/admin/releases", {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (resp.status === 401) { clearAuth(); throw new ApiError(401, "未登录或登录已过期"); }
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const d = await resp.json(); if (d?.message) msg = d.message; } catch { /* ignore */ }
      throw new ApiError(resp.status, msg);
    }
    return resp.json();
  },
  promoteRelease: (id: string) =>
    request<{ ok: boolean; version: string }>(`/api/admin/releases/${id}/promote`, { method: "POST" }),
  deleteRelease: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/releases/${id}`, { method: "DELETE" }),

  // App categories
  listAppCategories: (source?: string) => {
    const qs = source ? `?source=${encodeURIComponent(source)}` : "";
    return request<{ categories: AppCategoryRow[] }>(`/api/admin/app-categories${qs}`);
  },
  upsertAppCategory: (data: {
    app_identifier: string;
    category: "consumption" | "productive" | "neutral";
    sub_type: string;
    display_name?: string | null;
    rate_multiplier?: number;
  }) =>
    request<{ category: AppCategoryRow }>("/api/admin/app-categories", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteAppCategory: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/app-categories/${id}`, { method: "DELETE" }),

  // Defaults
  getDefaults: () => request<{ defaults: AdminDefaults }>("/api/admin/defaults"),
  saveDefaults: (data: AdminDefaults) =>
    request<{ defaults: AdminDefaults }>("/api/admin/defaults", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // System
  getSystem: () => request<AdminSystemView>("/api/admin/system"),
  saveSystem: (data: AdminSystemView["system"]) =>
    request<{ system: AdminSystemView["system"] }>("/api/admin/system", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Push
  getPush: () => request<{ push: AdminPushConfig }>("/api/admin/push"),
  savePush: (data: AdminPushConfig) =>
    request<{ push: AdminPushConfig }>("/api/admin/push", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  testPush: (channel: "wechat_work" | "smtp") =>
    request<{
      sent: Array<{ channel: string; ok: boolean; error?: string }>;
      skipped: Array<{ channel: string; reason: string }>;
    }>("/api/admin/push/test", {
      method: "POST",
      body: JSON.stringify({ channel }),
    }),

  // Daily summary
  getDailySummary: () =>
    request<{ daily_summary: AdminDailySummaryConfig }>("/api/admin/daily-summary"),
  saveDailySummary: (data: AdminDailySummaryConfig) =>
    request<{ daily_summary: AdminDailySummaryConfig }>("/api/admin/daily-summary", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  triggerDailySummary: () =>
    request<{ pushed: number; skipped: number; errors: number }>(
      "/api/admin/daily-summary/trigger",
      { method: "POST" },
    ),

  // Changelog (v0.4.9+) — 公开端点, 不强制 admin token
  getChangelog: () =>
    request<{ content: string; format: "markdown" }>("/api/changelog", {}, false),

  // Tenants
  listTenants: () => request<{ tenants: TenantRow[] }>("/api/admin/tenants"),
  resetTenantPassword: (id: string, password: string) =>
    request<{ ok: boolean }>(`/api/admin/tenants/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  deleteTenant: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/tenants/${id}`, { method: "DELETE" }),
};
