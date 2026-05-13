/** 封装 fetch: 自动带 Bearer, 统一错误处理。 */
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

// ── auth ──────────────────────────────────────────────────────
export interface AuthResp {
  token: string;
  parent: { id: string; username: string; created_at: string };
}

export const api = {
  register: (username: string, password: string) =>
    request<AuthResp>(
      "/auth/parent/register",
      { method: "POST", body: JSON.stringify({ username, password }) },
      false,
    ),

  login: (username: string, password: string) =>
    request<AuthResp>(
      "/auth/parent/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
      false,
    ),

  me: () =>
    request<{ id: string; username: string; created_at: string; child_count: string }>(
      "/auth/parent/me",
    ),

  // ── children ───────────────────────────────────────────────
  listChildren: () =>
    request<{ children: Array<Child> }>("/api/children"),

  createChild: (data: {
    username: string;
    display_name?: string;
    birth_year?: number;
  }) =>
    request<Child>("/api/children", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // ── devices ────────────────────────────────────────────────
  listDevices: () =>
    request<{ devices: Array<Device> }>("/api/devices"),

  createPair: (child_id: string, name?: string) =>
    request<{
      device_id: string;
      pairing_code: string;
      expires_in_minutes: number;
      instructions: string;
    }>("/api/devices/pair", {
      method: "POST",
      body: JSON.stringify({ child_id, name }),
    }),

  regeneratePair: (device_id: string) =>
    request<{
      device_id: string;
      pairing_code: string;
      expires_in_minutes: number;
      note: string;
    }>(`/api/devices/${device_id}/regenerate-pair`, { method: "POST" }),

  deleteDevice: (device_id: string) =>
    request<{ ok: boolean }>(`/api/devices/${device_id}`, { method: "DELETE" }),

  adjustWallet: (
    child_id: string,
    data: { delta: number; reason?: "parent_grant" | "adjustment" | "task_reward"; comment?: string },
  ) =>
    request<{ balance: number; delta: number; pushed: number }>(
      `/api/children/${child_id}/wallet/adjust`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  // ── commands ──────────────────────────────────────────────
  pushCommand: (data: {
    device_id: string;
    command_type: string;
    payload: Record<string, unknown>;
    expires_in_minutes?: number;
  }) =>
    request<{
      id: string;
      device_id: string;
      command_type: string;
      delivered: boolean;
      created_at: string;
    }>("/api/commands", { method: "POST", body: JSON.stringify(data) }),

  listCommands: (device_id: string) =>
    request<{ commands: Array<CommandRow> }>(
      `/api/commands?device_id=${encodeURIComponent(device_id)}`,
    ),

  // ── device online history ─────────────────────────────────
  getDeviceOnlineHistory: (device_id: string) =>
    request<{
      sessions: Array<OnlineSession>;
      today_total_seconds: number;
    }>(`/api/devices/${device_id}/online-history`),

  // ── rules ──────────────────────────────────────────────────
  listRules: (child_id: string) =>
    request<{ rules: Array<Rule> }>(
      `/api/rules?child_id=${encodeURIComponent(child_id)}`,
    ),

  createRule: (data: {
    child_id: string;
    name: string;
    enabled?: boolean;
    spec: RuleSpec;
  }) =>
    request<{ rule: Rule; pushed: number }>("/api/rules", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateRule: (
    id: string,
    data: { name?: string; enabled?: boolean; spec?: RuleSpec },
  ) =>
    request<{ rule: Rule; pushed: number }>(`/api/rules/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteRule: (id: string) =>
    request<{ ok: boolean; pushed: number }>(`/api/rules/${id}`, {
      method: "DELETE",
    }),

  // ── unlock_requests ────────────────────────────────────────
  listRequests: (status: "pending" | "approved" | "rejected" | "all" = "pending") =>
    request<{ requests: UnlockRequest[] }>(
      `/api/unlock-requests?status=${encodeURIComponent(status)}`,
    ),

  approveRequest: (
    id: string,
    data: { duration_minutes: number; rule_id?: string; comment?: string },
  ) =>
    request<{ request: UnlockRequest; pushed_to: number; command_id: string | null }>(
      `/api/unlock-requests/${id}/approve`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  rejectRequest: (id: string, comment?: string) =>
    request<{ request: UnlockRequest }>(`/api/unlock-requests/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    }),
};

// ── types ──────────────────────────────────────────────────────
export interface Child {
  id: string;
  parent_id: string;
  username: string;
  display_name: string | null;
  birth_year: number | null;
  maturity_mode: string;
  quota_package: string;
  trust_level: number;
  balance: number;
  created_at: string;
}

export interface Device {
  id: string;
  device_type: string;
  name: string | null;
  platform: string | null;
  last_seen_at: string | null;
  created_at: string;
  paired: boolean;
  child_id: string | null;
  /** 由 getConnectedDevices() 注入，仅 listDevices 才有 */
  online?: boolean;
}

/** 单段在线记录 (device_online_sessions 表) */
export interface OnlineSession {
  id: string;
  connected_at: string;
  disconnected_at: string | null;
  duration_seconds: number | null;
  remote_ip: string | null;
}

export interface CommandRow {
  id: string;
  command_type: string;
  payload: Record<string, unknown>;
  status: string;
  expires_at: string | null;
  created_at: string;
}

// ── rules ──────────────────────────────────────────────────────
export interface Matcher {
  field: "process_name" | "exe_path" | "window_title" | "command_line";
  op: "equals" | "iequals" | "contains" | "icontains" | "regex";
  value: string;
}

export interface RuleAction {
  type: "kill_and_warn" | "warn_only" | "kill_silent";
  message: string;
}

export interface RuleSpec {
  matchers: Matcher[];
  matcher_logic: "OR" | "AND";
  exclude_processes: string[];
  schedule: { mode: "always" | "windowed" | "disabled"; windows: unknown[] };
  action: RuleAction;
  category_link?: string;
  notify_parent: boolean;
}

export interface Rule {
  id: string;
  child_id: string;
  name: string;
  enabled: boolean;
  spec: RuleSpec;
  updated_at: string;
}

// ── unlock requests ───────────────────────────────────────────
export interface UnlockRequest {
  id: string;
  child_id: string;
  child_username?: string;
  display_name?: string | null;
  request_text: string;
  structured_request: unknown;
  llm_summary: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "timeout";
  parent_decision_at: string | null;
  parent_comment: string | null;
  created_at: string;
}
