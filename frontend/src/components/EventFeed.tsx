import {
  AlertTriangle,
  Ban,
  CheckSquare,
  CircleDot,
  ClipboardList,
  Gem,
  GraduationCap,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { MATURITY_LABELS } from "../lib/labels";
import { useEventStream, type LiveEvent } from "../lib/eventStream";

const TYPE_META: Record<
  string,
  { icon: LucideIcon; label: string; tone: "warn" | "info" | "ok" }
> = {
  block:             { icon: Ban,            label: "应用被拦截",     tone: "warn" },
  token_deduct:      { icon: Gem,            label: "扣 token",       tone: "warn" },
  token_credit:      { icon: Gem,            label: "挣 token",       tone: "ok"   },
  session_open:      { icon: LogIn,          label: "会话开始",       tone: "info" },
  session_close:     { icon: LogOut,         label: "会话结束",       tone: "info" },
  pin_fail:          { icon: AlertTriangle,  label: "PIN 错误",      tone: "warn" },
  jiggler_alert:     { icon: AlertTriangle,  label: "刷分嫌疑",      tone: "warn" },
  behavior_anomaly:  { icon: AlertTriangle,  label: "行为基线异常",  tone: "warn" },
  maturity_upgrade_suggestion: { icon: GraduationCap, label: "成熟度升级建议", tone: "ok" },
  unknown_app:       { icon: CircleDot,      label: "未知应用",       tone: "info" },
  unlock_request:    { icon: MessageSquare,  label: "孩子申请",       tone: "info" },
  task_claim:        { icon: ClipboardList,  label: "任务申报",       tone: "info" },
  checklist_tick:    { icon: CheckSquare,    label: "责任清单",       tone: "ok"   },
  status:            { icon: CircleDot,      label: "状态",           tone: "info" },
};

function _renderSummary(ev: LiveEvent): string {
  const p = ev.payload as Record<string, unknown>;
  if (ev.event_type === "block") {
    const proc = p?.process_name as string | undefined;
    const rule = p?.rule_name as string | undefined;
    return `${proc ?? "?"}${rule ? ` · 规则 ${rule}` : ""}`;
  }
  if (ev.event_type === "token_deduct" || ev.event_type === "token_credit") {
    const amount = p?.amount ?? p?.delta;
    const reason = p?.reason as string | undefined;
    return `${amount ?? "?"} ${reason ? `· ${reason}` : ""}`;
  }
  if (ev.event_type === "status") {
    const kind = p?.kind as string | undefined;
    const oldM = p?.old as string | undefined;
    const newM = p?.new as string | undefined;
    if (kind === "mode_change") return `${oldM} → ${newM}`;
    return kind ?? "";
  }
  if (ev.event_type === "session_open" || ev.event_type === "session_close") {
    const mode = p?.mode as string | undefined;
    return mode ?? "";
  }
  if (ev.event_type === "unknown_app") {
    const proc = p?.process_name as string | undefined;
    return proc ?? "";
  }
  if (ev.event_type === "unlock_request") {
    const text = p?.request_text as string | undefined;
    return text ? `「${text}」 → 去「申请」页处理` : "新申请, 去「申请」页处理";
  }
  if (ev.event_type === "task_claim") {
    const name = p?.task_name as string | undefined;
    const reward = p?.reward_tokens as number | undefined;
    return `${name ?? "任务"} → +${reward ?? 0} token, 去「任务」页审批`;
  }
  if (ev.event_type === "checklist_tick") {
    const tid = p?.task_id as string | undefined;
    const done = p?.completed as boolean | undefined;
    return `${tid ?? "—"} ${done ? "✓ 完成" : "✗ 撤销"}`;
  }
  if (ev.event_type === "maturity_upgrade_suggestion") {
    const from = (p?.from as string) ?? "?";
    const to = (p?.to as string) ?? "?";
    const trust = p?.trust_level as number | undefined;
    const fromCn = MATURITY_LABELS[from] ?? from;
    const toCn = MATURITY_LABELS[to] ?? to;
    return `信任值 Lv${trust ?? "?"} · 建议「${fromCn}」→「${toCn}」`;
  }
  if (ev.event_type === "behavior_anomaly") {
    const cat = p?.category as string | undefined;
    const today = p?.today_minutes as number | undefined;
    const avg = p?.baseline_avg_minutes as number | undefined;
    const ratio = p?.ratio as number | undefined;
    const catCn =
      cat === "consumption" ? "消遣类"
      : cat === "productive" ? "学习类"
      : (cat ?? "?");
    return `今日 ${catCn} ${today ?? "?"} 分 · 平均 ${avg ?? "?"} 分 · ${ratio ?? "?"}x 待核查`;
  }
  // 默认: 拍扁前 2 个字段
  const keys = Object.keys(p ?? {}).slice(0, 2);
  return keys.map((k) => `${k}=${String(p[k]).slice(0, 24)}`).join(" · ");
}

function _toneClass(tone: "warn" | "info" | "ok"): string {
  if (tone === "warn") return "bg-warn/10 text-warn";
  if (tone === "ok") return "bg-accent/15 text-accent-600";
  return "bg-brand-50 text-brand-600";
}

function _formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

/** Stream 由调用方注入: 避免本组件再单独开一条 WS。
 *  无参时默认自己 hook (兼容旧调用方)。 */
export default function EventFeed(props: {
  events?: LiveEvent[];
  state?: "connecting" | "open" | "closed" | "error";
  clear?: () => void;
}) {
  const hasInjected = props.events !== undefined;
  // 仅当未注入时才建自己的 WS; React 不允许条件 hook, 所以 hook 始终调用,
  // 但用 enabled flag 在 hook 内决定是否真连。
  const inner = useEventStream(!hasInjected);
  const events = hasInjected ? (props.events as LiveEvent[]) : inner.events;
  const state = hasInjected ? (props.state ?? "open") : inner.state;
  const clear = hasInjected ? (props.clear ?? (() => undefined)) : inner.clear;

  const indicator =
    state === "open" ? (
      <span className="flex items-center gap-1.5 text-accent-600 text-xs">
        <Wifi size={12} /> 实时
      </span>
    ) : state === "connecting" ? (
      <span className="flex items-center gap-1.5 text-ink-dim text-xs">
        <Loader2 size={12} className="animate-spin" /> 连接中…
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-warn text-xs">
        <WifiOff size={12} /> 已断开
      </span>
    );

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-ink uppercase tracking-wide">
          实时事件
        </h2>
        <div className="flex items-center gap-3">
          {indicator}
          {events.length > 0 && (
            <button onClick={clear} className="text-xs text-ink-dim hover:text-brand">
              清空
            </button>
          )}
        </div>
      </div>

      <div className="card divide-y divide-border/60">
        {events.length === 0 ? (
          <div className="p-6 text-center text-ink-dim text-sm">
            {state === "open"
              ? "等待孩子设备产生事件…"
              : state === "connecting"
                ? "正在连接服务器…"
                : "无法连接服务器, 5 秒后自动重试"}
          </div>
        ) : (
          events.map((ev, i) => {
            const meta = TYPE_META[ev.event_type] || TYPE_META.status;
            const Icon = meta.icon;
            return (
              <div key={i} className="p-3 flex items-center gap-3">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${_toneClass(meta.tone)}`}
                >
                  <Icon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink">
                    {meta.label}
                  </div>
                  <div className="text-xs text-ink-dim truncate">
                    {_renderSummary(ev)}
                  </div>
                </div>
                <div className="text-xs text-ink-light shrink-0">
                  {_formatTime(ev.occurred_at)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
