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

  listLedger: (child_id: string, limit = 50) =>
    request<{ entries: LedgerEntry[] }>(
      `/api/children/${child_id}/ledger?limit=${limit}`,
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
    data: { duration_minutes: number; comment?: string },
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

  // ── tasks ──────────────────────────────────────────────────
  listTasks: (child_id: string) =>
    request<{ tasks: Task[] }>(
      `/api/tasks?child_id=${encodeURIComponent(child_id)}`,
    ),

  createTask: (data: {
    child_id: string;
    name: string;
    category: TaskCategory;
    reward_tokens: number;
    daily_max_completions?: number;
    verification?: TaskVerification;
    schedule?: TaskSchedule;
    active?: boolean;
  }) =>
    request<{ task: Task; pushed: number }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateTask: (
    id: string,
    data: Partial<{
      name: string;
      category: TaskCategory;
      reward_tokens: number;
      daily_max_completions: number;
      verification: TaskVerification;
      schedule: TaskSchedule;
      active: boolean;
    }>,
  ) =>
    request<{ task: Task; pushed: number }>(`/api/tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteTask: (id: string) =>
    request<{ ok: boolean; pushed: number }>(`/api/tasks/${id}`, {
      method: "DELETE",
    }),

  // ── task completions (孩子申报 → 家长审批) ──────────────────
  listTaskCompletions: (status: "pending" | "approved" | "rejected" | "all" = "pending") =>
    request<{ completions: TaskCompletion[] }>(
      `/api/task-completions?status=${encodeURIComponent(status)}`,
    ),

  approveTaskCompletion: (
    id: string,
    data: { reward_override?: number; comment?: string } = {},
  ) =>
    request<{ ok: boolean; reward: number; balance: number; pushed: number }>(
      `/api/task-completions/${id}/approve`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  rejectTaskCompletion: (id: string, comment?: string) =>
    request<{ ok: boolean }>(`/api/task-completions/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    }),

  // ── responsibility checks ───────────────────────────────────
  listResponsibilityChecks: (child_id: string, days = 14) =>
    request<{
      checks: ResponsibilityCheck[];
      responsibility_tasks: Array<{ id: string; name: string }>;
      days: number;
    }>(
      `/api/responsibility-checks?child_id=${encodeURIComponent(child_id)}&days=${days}`,
    ),

  // ── free pass (§14.4) ───────────────────────────────────────
  startFreePass: (data: { child_id: string; duration_minutes: number; reason?: string }) =>
    request<{
      id: string;
      child_id: string;
      started_at: string;
      expected_duration_minutes: number;
      expires_at: string;
      reason: string | null;
      pushed: number;
    }>("/api/free-pass", { method: "POST", body: JSON.stringify(data) }),

  endFreePass: (id: string) =>
    request<{ ok: boolean; pushed: number }>(`/api/free-pass/${id}/end`, {
      method: "POST",
    }),

  getActiveFreePass: (child_id: string) =>
    request<{ active: ActiveFreePass | null }>(
      `/api/free-pass/active?child_id=${encodeURIComponent(child_id)}`,
    ),
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

// ── tasks ─────────────────────────────────────────────────────
export type TaskCategory = "responsibility" | "incentive";
export type TaskVerification = "parent_approve" | "self_report" | "auto";
export type TaskSchedule = "daily" | "weekly" | "once";
export type TaskCompletionStatus = "pending" | "approved" | "rejected";

export interface Task {
  id: string;
  child_id: string;
  name: string;
  category: TaskCategory;
  reward_tokens: number;
  daily_max_completions: number;
  verification: TaskVerification;
  schedule: TaskSchedule;
  active: boolean;
}

export interface TaskCompletion {
  id: string;
  task_id: string;
  child_id: string;
  status: TaskCompletionStatus;
  photo_url: string | null;
  child_note: string | null;
  llm_summary: string | null;
  parent_decision_at: string | null;
  parent_comment: string | null;
  reward_granted: number | null;
  created_at: string;
  child_username?: string;
  display_name?: string | null;
  task_name?: string;
  task_category?: TaskCategory;
  reward_tokens?: number;
}

export interface ResponsibilityCheck {
  check_date: string;
  task_id: string;
  task_name: string;
  completed: boolean;
}

// ── ledger ────────────────────────────────────────────────────
export interface LedgerEntry {
  id: string;
  delta: number;
  balance_after: number;
  reason: string;
  occurred_at: string;
}

// ── free pass ─────────────────────────────────────────────────
export interface ActiveFreePass {
  id: string;
  started_at: string;
  expected_duration_minutes: number;
  expires_at: string;
  remaining_seconds: number;
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
