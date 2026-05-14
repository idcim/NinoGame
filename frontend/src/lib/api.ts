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

  /** 修改孩子档位 (一键应用建议 / 家长手动调档). */
  updateChild: (
    child_id: string,
    data: { maturity_mode?: Child["maturity_mode"] },
  ) =>
    request<{ maturity_mode: string }>(`/api/children/${child_id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  /** 暂不升级: 把当前 maturity_suggestion 标记为 dismissed. */
  dismissMaturitySuggestion: (child_id: string) =>
    request<{ dismissed: string }>(
      `/api/children/${child_id}/maturity-suggestion/dismiss`,
      { method: "POST" },
    ),

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

  /** 全局 pending 数量 (Layout 顶部 badge 用) */
  getPendingCounts: () =>
    request<{ pending_tasks: number; pending_requests: number }>(
      `/api/pending-counts`,
    ),

  // ── 孩子 settings 上云 (Agent 端用) ──────────────────────
  getChildSettings: (child_id: string) =>
    request<{
      merged: ChildSettingsForm;
      raw: Partial<ChildSettingsForm>;
      defaults: ChildSettingsForm;
    }>(`/api/children/${child_id}/settings`),

  saveChildSettings: (child_id: string, partial: Partial<ChildSettingsForm>) =>
    request<{
      merged: ChildSettingsForm;
      raw: Partial<ChildSettingsForm>;
      pushed: number;
    }>(`/api/children/${child_id}/settings`, {
      method: "PUT",
      body: JSON.stringify(partial),
    }),

  resetChildSettings: (child_id: string) =>
    request<{ merged: ChildSettingsForm; pushed: number }>(
      `/api/children/${child_id}/settings/reset`,
      { method: "POST" },
    ),

  // ── reports (P3 使用时长统计; v0.4.4 加日/周/月切换) ────────
  getDailyReport: (
    child_id: string,
    periods = 14,
    granularity: Granularity = "day",
  ) =>
    request<{
      granularity: Granularity;
      periods: number;
      days: DailyReportRow[];
    }>(
      `/api/children/${child_id}/reports/daily?periods=${periods}&granularity=${granularity}`,
    ),
  getTopAppsReport: (child_id: string, days = 14, limit = 10) =>
    request<{ apps: TopAppRow[] }>(
      `/api/children/${child_id}/reports/top-apps?days=${days}&limit=${limit}`,
    ),

  /** 类别细分 (v0.4.5+): 应用类别按 active_seconds 占比, 纯描述性. */
  getCategoryBreakdown: (
    child_id: string,
    periods = 14,
    granularity: Granularity = "day",
  ) =>
    request<{
      granularity: Granularity;
      periods: number;
      total_active_seconds: number;
      categories: CategoryBreakdownRow[];
    }>(
      `/api/children/${child_id}/reports/category-breakdown?periods=${periods}&granularity=${granularity}`,
    ),

  // (v0.4.0+: LLM 配置 + Agent 升级包都搬到独立的 admin 后台,
  //  parent frontend 不再有这些 API; 见 admin/ 项目)

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

  /** 按天聚合: 每天总时长 + 段数, 默认 14 天 */
  getDeviceOnlineDaily: (device_id: string, days = 14) =>
    request<{
      days: Array<{ date: string; total_seconds: number; session_count: number }>;
    }>(`/api/devices/${device_id}/online-history?mode=daily&days=${days}`),

  /** 指定一天的全部 sessions (下钻视图) */
  getDeviceOnlineByDate: (device_id: string, date: string) =>
    request<{
      date: string;
      sessions: Array<OnlineSession>;
    }>(`/api/devices/${device_id}/online-history?date=${encodeURIComponent(date)}`),

  /** Agent 实时决策状态 (扣不扣 / 原因 / 余额 / 前台) */
  getAgentState: (device_id: string) =>
    request<{ state: AgentState | null }>(`/api/devices/${device_id}/agent-state`),

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

  /** LLM 一句话 → 规则 draft (不落库; 前端预填编辑器后家长再保存). */
  draftRuleFromText: (child_id: string, text: string) =>
    request<{ draft: RuleDraft }>("/api/rules/draft-from-text", {
      method: "POST",
      body: JSON.stringify({ child_id, text }),
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
export type MaturityMode =
  | "strict"
  | "negotiable"
  | "advisory"
  | "self_regulated";

export interface MaturitySuggestion {
  from: MaturityMode;
  to: MaturityMode;
  trust_level: number;
  suggested_at: string;
}

export interface Child {
  id: string;
  parent_id: string;
  username: string;
  display_name: string | null;
  birth_year: number | null;
  maturity_mode: MaturityMode;
  quota_package: string;
  trust_level: number;
  balance: number;
  created_at: string;
  /** 系统给出的"建议升档"提示, 没有时为 null. */
  maturity_suggestion: MaturitySuggestion | null;
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

/** LLM 一句话生成的规则草稿 (尚未落库, 家长可在编辑器里再调). */
export interface RuleDraft {
  name: string;
  keywords: string[];
  action: "kill_and_warn" | "warn_only" | "kill_silent";
  message: string;
  schedule: {
    mode: "always" | "windowed" | "disabled";
    windows: Array<{ days: number[]; from: string; to: string }>;
  };
  reasoning: string;
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

// ── agent state ───────────────────────────────────────────────
/** 决策 #33: rate / credited 不再使用 (Path 1 + rate_multiplier 下线),
 *  保留类型字段以兼容老 Agent 推上来的旧 payload。 */
export interface AgentState {
  kind: "token_decision";
  foreground: string | null;
  category: string | null;
  rate?: number;
  mode_active: boolean;
  balance: number;
  deducted: number;
  credited?: number;
  skip_reason: string | null;
  updated_at: string;
}

// ── ledger ────────────────────────────────────────────────────
export interface LedgerEntry {
  id: string;
  delta: number;
  balance_after: number;
  reason: string;
  occurred_at: string;
}

// ── 孩子 settings (Agent 端配置上云) ──────────────────────────
export interface ChildSettingsForm {
  idle_lock_minutes: number;
  billing_tick_seconds: number;
  token_to_minute_ratio: number;
  daily_hard_cap_minutes: number;
  weekday_base_tokens: number;
  weekend_base_tokens: number;
  daily_credit_cap: number;
  high_consumption_rate: number;
  low_balance_warn_threshold: number;
  overlay_enabled: boolean;
  warning_dialog_auto_close_seconds: number;
  monitor_scan_interval_seconds: number;
  jiggler_detector_enabled: boolean;
  jiggler_box_threshold_px: number;
  messages: Record<string, string>;
  request_quick_options: string[];
}

// LLM 配置类型 / Agent 升级包类型 已经搬到 admin/src/lib/api.ts

// ── reports ───────────────────────────────────────────────────
export type Granularity = "day" | "week" | "month";

/** 一行聚合数据 (按 granularity 决定桶宽).
 *  date 是 legacy alias = period_start, 新代码请用 period_start. */
export interface DailyReportRow {
  date: string;
  period_start: string;
  period_end: string;
  active_seconds: number;
  tokens_consumed: number;
  session_count: number;
}

export interface CategoryBreakdownRow {
  category: string;
  active_seconds: number;
  session_count: number;
  percentage: number;
}

export interface TopAppRow {
  app_identifier: string;
  category: string;
  display_name: string | null;
  sub_type: string | null;
  total_active_seconds: number;
  total_tokens: number;
  session_count: number;
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
