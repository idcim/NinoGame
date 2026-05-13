import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Gamepad2,
  Gem,
  Gift,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  RotateCw,
  Settings,
  Trash2,
  Unlock,
} from "lucide-react";
import {
  api,
  ApiError,
  type ActiveFreePass,
  type AgentState,
  type CommandRow,
  type Device,
  type OnlineSession,
} from "../lib/api";
import {
  commandLabel,
  commandStatusLabel,
  deviceTypeLabel,
  formatDuration,
  onlineLabel,
  platformLabel,
  timeAgo,
} from "../lib/labels";

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const [devs, cmds] = await Promise.all([
        api.listDevices(),
        api.listCommands(id),
      ]);
      const d = devs.devices.find((x) => x.id === id);
      setDevice(d || null);
      setCommands(cmds.commands);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  if (!id) return null;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-ink-dim hover:text-brand inline-flex items-center gap-1">
          <ArrowLeft size={14} />
          返回
        </Link>
        <div className="flex items-end justify-between mt-2">
          <div>
            <h1 className="text-2xl font-bold text-ink flex items-center gap-2 flex-wrap">
              {device?.name || "设备详情"}
              {device && (
                <span
                  className={
                    "text-xs font-medium px-2 py-0.5 rounded-full " +
                    (device.online
                      ? "bg-accent/15 text-accent-600"
                      : "bg-ink-light/15 text-ink-dim")
                  }
                >
                  ● {onlineLabel(!!device?.online)}
                </span>
              )}
            </h1>
            <p className="text-sm text-ink-dim mt-1">
              {platformLabel(device?.platform)} · {deviceTypeLabel(device?.device_type)} ·{" "}
              {device?.online ? (
                <span className="text-accent-600">现在在线</span>
              ) : (
                <>最后在线 {timeAgo(device?.last_seen_at)}</>
              )}
            </p>
          </div>
          <button onClick={load} className="btn-ghost" disabled={loading}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            刷新
          </button>
        </div>
      </div>

      {err && (
        <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>
      )}

      <AgentStateCard deviceId={id} online={!!device?.online} />

      <QuickActions deviceId={id} onPushed={load} />

      {device?.child_id && <FreePassSection childId={device.child_id} />}

      <DeviceAdmin
        deviceId={id}
        onRegenerated={load}
        onDeleted={() => nav("/", { replace: true })}
      />

      <OnlineHistory deviceId={id} />

      <section>
        <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
          命令历史 ({commands.length})
        </h2>
        {commands.length === 0 && !loading && (
          <div className="card p-6 text-center text-ink-dim">
            还没有发过命令
          </div>
        )}
        <div className="space-y-2">
          {commands.map((c) => (
            <CommandRowView key={c.id} cmd={c} />
          ))}
        </div>
      </section>
    </div>
  );
}

function QuickActions({
  deviceId,
  onPushed,
}: {
  deviceId: string;
  onPushed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showPinForm, setShowPinForm] = useState(false);

  async function push(command_type: string, payload: Record<string, unknown>, label: string) {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await api.pushCommand({ device_id: deviceId, command_type, payload });
      setMsg(`${label} 已${r.delivered ? "实时下发" : "排队 (设备离线, 上线时补发)"}`);
      onPushed();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "推送失败");
    } finally {
      setBusy(false);
    }
  }

  const unlockButtons = [10, 30, 60];

  return (
    <section>
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
        <Gamepad2 size={18} className="text-brand" />
        快捷操作
      </h2>
      <div className="card p-5 space-y-4">
        <div>
          <div className="text-sm font-semibold mb-2">临时放行游戏</div>
          <div className="text-xs text-ink-dim mb-3">
            选择放行时长 (期间该孩子所有 enabled 规则的游戏都不被拦截; token 仍按规则费率扣)
          </div>
          <div className="flex gap-2 flex-wrap">
            {unlockButtons.map((m) => (
              <button
                key={m}
                onClick={() =>
                  push(
                    "temporary_unlock",
                    // 不传 rule_id: backend 自动展开为该孩子全部 enabled 规则
                    { duration_seconds: m * 60 },
                    `放行 ${m} 分钟`,
                  )
                }
                disabled={busy}
                className="btn-primary"
              >
                <Unlock size={14} />
                放行 {m} 分钟
              </button>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-border">
          <div className="text-sm font-semibold mb-2">设备控制</div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => push("lock_device", {}, "立即锁定")}
              disabled={busy}
              className="btn-ghost"
            >
              <Lock size={14} />
              立即锁定设备
            </button>
            <button
              onClick={() => setShowPinForm(true)}
              disabled={busy}
              className="btn-ghost"
            >
              <KeyRound size={14} />
              设置 / 重置 PIN
            </button>
          </div>
        </div>

        {msg && (
          <div className="text-sm text-accent-600 bg-accent/10 border border-accent/30 rounded px-3 py-2">
            ✓ {msg}
          </div>
        )}
        {err && (
          <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
            {err}
          </div>
        )}
      </div>

      {showPinForm && (
        <PinDialog
          onClose={() => setShowPinForm(false)}
          onSubmit={async (pin) => {
            if (pin === "") {
              await push("clear_pin", {}, "清空 PIN");
            } else {
              await push("set_pin", { pin }, "设置 PIN");
            }
            setShowPinForm(false);
          }}
        />
      )}
    </section>
  );
}

function PinDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (pin.length < 4) {
      setErr("PIN 至少 4 位");
      return;
    }
    if (pin !== pin2) {
      setErr("两次输入不一致");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pin);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "推送失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "推送失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div className="card p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-2 flex items-center gap-2">
          <KeyRound size={18} className="text-brand" />
          设置家长 PIN
        </h3>
        <p className="text-xs text-ink-dim mb-4">
          家长 PIN 用于 Agent 退出验证。PIN 通过 WebSocket 推送到孩子设备，
          Agent 用 PBKDF2-SHA256 加密存到本地 settings.json。生产环境务必走 wss://。
        </p>

        <form onSubmit={handleSet} className="space-y-3">
          <div>
            <label className="label">新 PIN (4-12 位)</label>
            <input
              type="password"
              className="input"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              minLength={4}
              maxLength={12}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="label">再输一次</label>
            <input
              type="password"
              className="input"
              value={pin2}
              onChange={(e) => setPin2(e.target.value)}
              minLength={4}
              maxLength={12}
              required
            />
          </div>

          {err && (
            <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
              {err}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={handleClear}
              className="btn-ghost text-warn"
              disabled={busy}
              title="清空设备上的 PIN, 退出 Agent 不再要求验证"
            >
              <Trash2 size={14} />
              清空 PIN
            </button>
            <div className="flex-1" />
            <button type="button" onClick={onClose} className="btn-ghost" disabled={busy}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "推送中..." : "设置"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeviceAdmin({
  deviceId,
  onRegenerated,
  onDeleted,
}: {
  deviceId: string;
  onRegenerated: () => void;
  onDeleted: () => void;
}) {
  const [newCode, setNewCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function regenerate() {
    if (
      !confirm(
        "重生配对码会作废当前 Agent 的 token, " +
        "在该 Agent 上必须用新码重新配对。继续?",
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.regeneratePair(deviceId);
      setNewCode(r.pairing_code);
      onRegenerated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "失败");
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm("删除此设备? 该 Agent 的 token 将作废, 记录保留在事件历史里。")) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteDevice(deviceId);
      onDeleted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "失败");
      setBusy(false);
    }
  }

  const link = newCode ? `${window.location.origin}/#pair=${newCode}` : "";

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <section>
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
        <Settings size={18} className="text-brand" />
        设备管理
      </h2>
      <div className="card p-5 space-y-3">
        {!newCode ? (
          <>
            <div className="flex flex-wrap gap-2">
              <button onClick={regenerate} disabled={busy} className="btn-ghost">
                <RotateCw size={14} />
                重新生成配对码
              </button>
              <button onClick={del} disabled={busy} className="btn-ghost text-warn">
                <Trash2 size={14} />
                删除设备
              </button>
            </div>
            <p className="text-xs text-ink-dim">
              重生配对码 = 作废当前 Agent token (它会断线), 30 分钟内可在 Agent 上输入新码重新配对。
              删除设备 = 整行记录被清, Agent token 永久失效。
            </p>
          </>
        ) : (
          <div className="space-y-3">
            <div className="text-sm font-semibold text-accent-600">
              ✓ 新配对码已生成, 30 分钟内有效
            </div>
            <div className="text-4xl font-mono font-bold text-brand tracking-widest select-all py-2 text-center">
              {newCode}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-brand-50 text-xs text-ink truncate">
                {link}
              </div>
              <button
                onClick={copyLink}
                className={
                  "px-3 py-2 rounded-lg border flex items-center gap-1.5 text-xs " +
                  (copied
                    ? "bg-accent text-white border-accent"
                    : "border-border text-ink-dim hover:text-brand hover:border-brand")
                }
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <p className="text-xs text-ink-dim">
              Agent 端: 托盘 → 「重新配对家长后台...」→ 粘贴上面的链接 → 完成。
            </p>
            <button
              onClick={() => setNewCode(null)}
              className="btn-ghost text-xs"
            >
              收起
            </button>
          </div>
        )}
        {err && (
          <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
            {err}
          </div>
        )}
      </div>
    </section>
  );
}

function CommandRowView({ cmd }: { cmd: CommandRow }) {
  const isUnlock = cmd.command_type === "temporary_unlock";
  const dur =
    (cmd.payload?.duration_seconds as number | undefined) ??
    ((cmd.payload?.duration_minutes as number | undefined) ?? 0) * 60;

  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
        {isUnlock ? <Unlock size={16} /> : <Lock size={16} />}
      </div>
      <div className="flex-1 text-sm">
        <div className="font-medium">
          {commandLabel(cmd.command_type)}
          {isUnlock && dur > 0 && (
            <span className="text-ink-dim font-normal ml-2">
              <Clock size={12} className="inline mr-1" />
              {formatDuration(dur)}
            </span>
          )}
        </div>
        <div className="text-xs text-ink-light mt-0.5">
          {new Date(cmd.created_at).toLocaleString()} · {commandStatusLabel(cmd.status)}
        </div>
      </div>
    </div>
  );
}

interface DailyRow {
  date: string;
  total_seconds: number;
  session_count: number;
}

// ── 实时状态卡 ────────────────────────────────────────────────
// 决策 #33: 统一在线时长扣分。skip_reason 简化, category 仅作展示标签不参与决策。
const SKIP_REASON_LABELS: Record<string, { text: string; tone: "warn" | "info" | "ok" }> = {
  mode_off:       { text: "Lock 或 Parent 模式, 不计费",      tone: "info" },
  free_pass:      { text: "限免活动中, 不扣 token",            tone: "ok"   },
  idle_user:      { text: "用户最近 2 分钟无键鼠输入",         tone: "info" },
  daily_cap:      { text: "已达每日硬上限, 不再扣",            tone: "warn" },
  out_of_balance: { text: "余额耗尽, 不再扣 (家长可远程锁定)", tone: "warn" },
  zero_cost:      { text: "本 tick 计算下来 0 token (短停顿)", tone: "info" },
};

// category 仅做信息展示 (classifier 留存的审计标签); 不影响"为什么不扣"
const CATEGORY_BADGE: Record<string, { text: string; cls: string }> = {
  consumption: { text: "消耗类", cls: "bg-warn/15 text-warn"          },
  productive:  { text: "学习类", cls: "bg-accent/15 text-accent-600"  },
  neutral:     { text: "中性",   cls: "bg-ink-light/15 text-ink-dim"  },
  unknown:     { text: "未分类", cls: "bg-ink-light/15 text-ink-dim"  },
};

function AgentStateCard({ deviceId, online }: { deviceId: string; online: boolean }) {
  const [state, setState] = useState<AgentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api.getAgentState(deviceId);
      setState(r.state);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // 每 10s 轮询一次; STATUS 事件 server 端不写库, 单进程 Map 缓存
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [deviceId]);

  const isDeducting = state?.deducted && state.deducted > 0;
  const skipMeta = state?.skip_reason ? SKIP_REASON_LABELS[state.skip_reason] : null;
  const catMeta = state?.category ? CATEGORY_BADGE[state.category] : null;

  // tick 间隔 60s, 显示数据新旧
  const ageSec = state?.updated_at
    ? Math.floor((Date.now() - new Date(state.updated_at).getTime()) / 1000)
    : Infinity;
  const isStale = ageSec > 90;

  return (
    <section>
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
        <Activity size={18} className="text-brand" />
        Agent 实时状态
        <span className="text-xs text-ink-light font-normal ml-auto">
          {state ? (
            <>更新于 {ageSec < 5 ? "刚刚" : `${ageSec} 秒前`}{isStale && " · 可能离线"}</>
          ) : online ? "等待第一次 tick (最多 60 秒)..." : "设备离线"}
        </span>
      </h2>
      <div className="card p-5 space-y-3">
        {err && (
          <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
            {err}
          </div>
        )}

        {!state && !loading && !err && (
          <div className="text-sm text-ink-dim">
            还没收到 Agent 决策 tick。Agent 启动后每 60 秒会发一次状态。
            <br />
            <span className="text-xs">
              如果一直没有, 检查: 设备是否在线 / 是否处于 child 模式 / Agent 是否最新版本 (本功能 v0.6+ 才有)。
            </span>
          </div>
        )}

        {state && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {/* 前台 */}
              <div>
                <div className="text-xs text-ink-light">当前前台</div>
                <div className="font-mono font-semibold text-ink truncate" title={state.foreground ?? "—"}>
                  {state.foreground ?? "—"}
                </div>
                {catMeta && (
                  <span className={"badge mt-1 inline-block " + catMeta.cls} title="仅审计标签, 不参与扣分判定">
                    {catMeta.text}
                  </span>
                )}
              </div>

              {/* 余额 */}
              <div>
                <div className="text-xs text-ink-light">本地余额</div>
                <div className="flex items-center gap-1 text-brand font-bold text-lg">
                  <Gem size={14} />
                  {state.balance}
                </div>
              </div>

              {/* 本 tick 结果 */}
              <div>
                <div className="text-xs text-ink-light">本 tick</div>
                {isDeducting ? (
                  <div className="font-bold text-warn">−{state.deducted} token</div>
                ) : (
                  <div className="text-ink-dim">不扣</div>
                )}
              </div>

              {/* 模式 */}
              <div>
                <div className="text-xs text-ink-light">会话模式</div>
                <div className={state.mode_active ? "text-accent-600 font-medium" : "text-ink-dim"}>
                  {state.mode_active ? "● Child 计费中" : "○ Lock / Parent"}
                </div>
              </div>
            </div>

            {/* 为什么不扣 */}
            {skipMeta && (
              <div
                className={
                  "text-sm rounded px-3 py-2 border " +
                  (skipMeta.tone === "warn"
                    ? "bg-warn/10 border-warn/30 text-warn"
                    : skipMeta.tone === "ok"
                      ? "bg-accent/10 border-accent/30 text-accent-600"
                      : "bg-brand-50 border-brand-50 text-ink")
                }
              >
                <span className="font-semibold">为什么不扣:</span> {skipMeta.text}
              </div>
            )}

            {isDeducting && (
              <div className="text-xs text-ink-light">
                每 60 秒 tick 一次 · 数据由 Agent 通过 WS 推送, 不落库
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** "2026-05-13T00:00:00Z" / "2026-05-13" → "2026-05-13" (本地日期前缀); 用作 group key */
function todayDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** server 返回的 date 可能是 ISO 时间戳, 截到日期; 今天显示为 "今天 (周几)". */
function formatDate(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return isToday ? `今天 ${wd}` : `${m}-${day} ${wd}`;
}

function OnlineHistory({ deviceId }: { deviceId: string }) {
  const [days, setDays] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // 哪些日期已展开 (date -> sessions, undefined 表示未加载)
  const [expanded, setExpanded] = useState<Record<string, OnlineSession[] | "loading" | undefined>>({});

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.getDeviceOnlineDaily(deviceId, 14);
      setDays(r.days);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setExpanded({});
  }, [deviceId]);

  async function toggle(date: string) {
    const cur = expanded[date];
    if (cur && cur !== "loading") {
      // 已展开 → 折叠
      setExpanded((p) => ({ ...p, [date]: undefined }));
      return;
    }
    // 未展开 → 拉数据
    setExpanded((p) => ({ ...p, [date]: "loading" }));
    try {
      const r = await api.getDeviceOnlineByDate(deviceId, date);
      setExpanded((p) => ({ ...p, [date]: r.sessions }));
    } catch (e) {
      setExpanded((p) => ({ ...p, [date]: [] }));
      setErr(e instanceof ApiError ? e.message : "加载当天失败");
    }
  }

  const todayTotal = days.find((d) => d.date.startsWith(todayDateStr()))?.total_seconds ?? 0;

  return (
    <section>
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
        <Clock size={18} className="text-brand" />
        在线历史
      </h2>
      <div className="card p-5 space-y-3">
        {/* 今天总时长 */}
        <div className="flex items-baseline gap-3 pb-3 border-b border-border">
          <span className="text-xs text-ink-dim">今日 Agent 在线总时长</span>
          <span className="text-2xl font-bold text-brand">
            {formatDuration(todayTotal)}
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="ml-auto btn-ghost text-xs"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            刷新
          </button>
        </div>

        {err && (
          <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
            {err}
          </div>
        )}

        {days.length === 0 && !loading && !err && (
          <div className="text-sm text-ink-dim text-center py-4">
            最近 14 天还没有在线记录
          </div>
        )}

        {/* 按天列表 */}
        {days.length > 0 && (
          <ul className="divide-y divide-border/60">
            {days.map((d) => {
              const cur = expanded[d.date];
              const isOpen = cur && cur !== "loading";
              const isLoading = cur === "loading";
              return (
                <li key={d.date}>
                  <button
                    type="button"
                    onClick={() => toggle(d.date)}
                    className="w-full flex items-center gap-3 py-3 text-left hover:bg-brand-50/30 -mx-2 px-2 rounded-md"
                  >
                    <span className="text-ink-dim shrink-0">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                    <span className="text-sm font-medium text-ink w-28 shrink-0 font-mono">
                      {formatDate(d.date)}
                    </span>
                    <span className="flex-1 text-sm text-ink">
                      {formatDuration(d.total_seconds)}
                    </span>
                    <span className="text-xs text-ink-light shrink-0">
                      {d.session_count} 段
                    </span>
                    {isLoading && <Loader2 size={12} className="animate-spin text-ink-dim" />}
                  </button>
                  {isOpen && Array.isArray(cur) && (
                    <div className="ml-6 mb-3 overflow-x-auto">
                      {cur.length === 0 ? (
                        <div className="text-xs text-ink-dim py-2">当天没有 session 记录</div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs text-ink-light border-b border-border/60">
                              <th className="text-left py-1.5 font-normal">开始</th>
                              <th className="text-left py-1.5 font-normal">结束</th>
                              <th className="text-right py-1.5 font-normal">时长</th>
                              <th className="text-right py-1.5 font-normal hidden sm:table-cell">来源 IP</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cur.map((s) => {
                              const isLive = !s.disconnected_at;
                              const dur = isLive
                                ? Math.floor((Date.now() - new Date(s.connected_at).getTime()) / 1000)
                                : s.duration_seconds ?? 0;
                              return (
                                <tr key={s.id} className="border-b border-border/40 last:border-0">
                                  <td className="py-1.5 text-xs">
                                    {new Date(s.connected_at).toLocaleTimeString()}
                                  </td>
                                  <td className="py-1.5 text-xs">
                                    {isLive ? (
                                      <span className="text-accent-600 font-medium">进行中</span>
                                    ) : (
                                      new Date(s.disconnected_at!).toLocaleTimeString()
                                    )}
                                  </td>
                                  <td className="py-1.5 text-right font-mono text-xs">
                                    {formatDuration(dur)}
                                  </td>
                                  <td className="py-1.5 text-right text-ink-light text-xs hidden sm:table-cell">
                                    {s.remote_ip || "—"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function FreePassSection({ childId }: { childId: string }) {
  const [active, setActive] = useState<ActiveFreePass | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 每秒刷新一次倒计时显示, 每 30s 才真正打 API 查最新活跃段
  const [tick, setTick] = useState(0);

  async function load() {
    try {
      const r = await api.getActiveFreePass(childId);
      setActive(r.active);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    }
  }

  useEffect(() => {
    load();
    const poll = setInterval(load, 30_000);
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(t);
    };
  }, [childId]);

  async function start(minutes: number) {
    if (
      active &&
      !confirm(`当前还有限免在进行中, 启动新一段会覆盖它。继续?`)
    )
      return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await api.startFreePass({
        child_id: childId,
        duration_minutes: minutes,
      });
      setMsg(
        `限免 ${minutes} 分钟已${
          r.pushed > 0 ? `下发到 ${r.pushed} 台在线设备` : "记录 (该孩子设备暂未连上)"
        }`,
      );
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "失败");
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!active) return;
    if (!confirm("终止当前限免? 终止后 consumption 类应用会立刻恢复扣 token。")) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await api.endFreePass(active.id);
      setMsg(`限免已终止 (下发到 ${r.pushed} 台在线设备)`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "失败");
    } finally {
      setBusy(false);
    }
  }

  // tick 强制 re-render; remaining 直接从 expires_at 算, 比 server 的 remaining_seconds 更精确
  const remainingSec = active
    ? Math.max(0, Math.floor((new Date(active.expires_at).getTime() - Date.now()) / 1000))
    : 0;
  // 仅用于让 lint 知道 tick 是有意被读到, 实际 re-render 由 setTick 触发
  void tick;
  const remainingMin = Math.ceil(remainingSec / 60);

  return (
    <section>
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
        <Gift size={18} className="text-brand" />
        限免活动 (§14.4)
      </h2>
      <div className="card p-5 space-y-4">
        {active && remainingSec > 0 ? (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-accent/15 text-accent-600 flex items-center justify-center text-xl">
                  🎁
                </div>
                <div>
                  <div className="font-semibold text-ink">
                    限免中 · 剩 {remainingMin} 分
                  </div>
                  <div className="text-xs text-ink-dim">
                    起 {new Date(active.started_at).toLocaleTimeString()} ·
                    {" "}计划 {active.expected_duration_minutes} 分 ·
                    {" "}到期 {new Date(active.expires_at).toLocaleTimeString()}
                  </div>
                </div>
              </div>
              <button onClick={end} disabled={busy} className="btn-ghost text-warn">
                <Lock size={14} />
                立即终止
              </button>
            </div>
            <p className="text-xs text-ink-dim">
              期间该孩子所有设备上的 consumption 类应用不扣 token, 但仍记录 active 时间用于审计。
              到期后 Agent 自动恢复正常计费 + 弹通知。
            </p>
          </>
        ) : (
          <>
            <div className="text-sm text-ink-dim">
              一键放行: 期间 consumption 类应用 (PvZ / 视频 / 漫画 / 社交) 不扣 token,
              规则仍生效 (没解锁 PvZ 还是会被拦)。常用于"今天家里有客"或"周末特别奖励"。
            </div>
            <div className="flex gap-2 flex-wrap">
              {[30, 60, 120].map((m) => (
                <button
                  key={m}
                  onClick={() => start(m)}
                  disabled={busy}
                  className="btn-primary"
                >
                  <Gift size={14} />
                  限免 {m >= 60 ? `${m / 60} 小时` : `${m} 分钟`}
                </button>
              ))}
            </div>
          </>
        )}

        {msg && (
          <div className="text-sm text-accent-600 bg-accent/10 border border-accent/30 rounded px-3 py-2">
            ✓ {msg}
          </div>
        )}
        {err && (
          <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
            {err}
          </div>
        )}
      </div>
    </section>
  );
}
