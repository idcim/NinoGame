/** 把后端枚举值翻译成家长能看懂的中文。
 *
 * 全前端统一从这里取，避免每个组件自己映射。
 * 后端值不变（代码里仍是 "negotiable" 等 enum），只是 UI 显示中文。
 */

// 成熟度模式 (CLAUDE.md §5)
export const MATURITY_LABELS: Record<string, string> = {
  strict:         "严管 (6-9 岁)",
  negotiable:     "协商 (10-13 岁)",
  advisory:       "建议 (13-16 岁)",
  self_regulated: "自管 (16+)",
};

export function maturityLabel(v?: string | null): string {
  return MATURITY_LABELS[v || ""] || v || "未知";
}

// 配额档位 (§6)
export const QUOTA_LABELS: Record<string, string> = {
  tight:        "严守型",
  balanced:     "平衡型",
  task_driven:  "任务驱动",
  trust:        "信任放手",
  custom:       "自定义",
};

export function quotaLabel(v?: string | null): string {
  return QUOTA_LABELS[v || ""] || v || "—";
}

// 设备类型 (§4)
export const DEVICE_TYPE_LABELS: Record<string, string> = {
  child_primary:  "孩子主用",
  parent_primary: "家长主用",
  shared:         "共享设备",
};

export function deviceTypeLabel(v?: string | null): string {
  return DEVICE_TYPE_LABELS[v || ""] || v || "—";
}

// 会话模式
export const MODE_LABELS: Record<string, string> = {
  child:         "使用中",
  parent:        "家长模式",
  lock:          "已锁定",
  limited_free:  "限免中",
};

export function modeLabel(v?: string | null): string {
  return MODE_LABELS[v || ""] || v || "—";
}

// 应用分类
export const CATEGORY_LABELS: Record<string, string> = {
  consumption: "消遣类",   // 玩 = 扣 token
  productive:  "学习类",   // 用 = 挣 token
  neutral:     "中性",     // 不扣不挣
};

export function categoryLabel(v?: string | null): string {
  return CATEGORY_LABELS[v || ""] || v || "—";
}

// 平台
export const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows 电脑",
  macos:   "Mac",
  linux:   "Linux",
  android: "安卓手机",
};

export function platformLabel(v?: string | null): string {
  return PLATFORM_LABELS[v || ""] || v || "—";
}

// 命令类型
export const COMMAND_LABELS: Record<string, string> = {
  temporary_unlock: "临时放行",
  lock_device:      "立即锁定",
  start_free_pass:  "开启限免",
  end_free_pass:    "结束限免",
  request_status:   "查询状态",
  request_photo:    "请求拍照",
  set_pin:          "设置 PIN",
  clear_pin:        "清空 PIN",
};

export function commandLabel(v?: string | null): string {
  return COMMAND_LABELS[v || ""] || v || "—";
}

// 命令状态
export const COMMAND_STATUS_LABELS: Record<string, string> = {
  pending:   "等待下发",
  delivered: "已下发",
  ack:       "已执行",
  expired:   "已过期",
  failed:    "失败",
};

export function commandStatusLabel(v?: string | null): string {
  return COMMAND_STATUS_LABELS[v || ""] || v || "—";
}

// 规则动作
export const ACTION_LABELS: Record<string, string> = {
  kill_and_warn: "直接拦截",
  warn_only:     "只提示",
  kill_silent:   "悄悄拦截",
};

export function actionLabel(v?: string | null): string {
  return ACTION_LABELS[v || ""] || v || "—";
}

// 申请状态
export const REQUEST_STATUS_LABELS: Record<string, string> = {
  pending:  "待批准",
  approved: "已批准",
  rejected: "已拒绝",
  expired:  "已过期",
  timeout:  "超时未回",
};

export function requestStatusLabel(v?: string | null): string {
  return REQUEST_STATUS_LABELS[v || ""] || v || "—";
}

// ledger 原因
export const LEDGER_REASON_LABELS: Record<string, string> = {
  daily_grant:      "每日发放",
  parent_grant:     "家长发奖",
  task_reward:      "任务奖励",
  adjustment:       "调账",
  app_consumption:  "玩耍扣费",
  app_consumption_aggregated: "玩耍扣费",
  path1_auto:       "自动挣分",
  refund:           "退款",
  unlock_prepay:    "放行预扣",
  streak_bonus:     "连续奖励",
  server_sync:      "余额同步",
};

export function ledgerReasonLabel(v?: string | null): string {
  return LEDGER_REASON_LABELS[v || ""] || v || "—";
}

// 在线/离线
export function onlineLabel(online: boolean): string {
  return online ? "在线" : "离线";
}

// 时长格式化: 86400 → "1 天" / 3600 → "1 小时" / 90 → "1 分 30 秒"
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "—";
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h ? `${d} 天 ${h} 小时` : `${d} 天`;
}

// "X 秒前 / X 分钟前 / X 小时前 / X 天前"
export function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(iso).toLocaleDateString();
}
