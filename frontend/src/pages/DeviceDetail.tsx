import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Gamepad2,
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

function OnlineHistory({ deviceId }: { deviceId: string }) {
  const [sessions, setSessions] = useState<OnlineSession[]>([]);
  const [todayTotal, setTodayTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.getDeviceOnlineHistory(deviceId);
      setSessions(r.sessions);
      setTodayTotal(r.today_total_seconds);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [deviceId]);

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

        {sessions.length === 0 && !loading && !err && (
          <div className="text-sm text-ink-dim text-center py-4">
            还没有在线记录
          </div>
        )}

        {/* 段列表 */}
        {sessions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-ink-light border-b border-border">
                  <th className="text-left py-2 font-normal">开始</th>
                  <th className="text-left py-2 font-normal">结束</th>
                  <th className="text-right py-2 font-normal">时长</th>
                  <th className="text-right py-2 font-normal hidden sm:table-cell">来源 IP</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const isOpen = !s.disconnected_at;
                  const dur = isOpen
                    ? Math.floor((Date.now() - new Date(s.connected_at).getTime()) / 1000)
                    : s.duration_seconds ?? 0;
                  return (
                    <tr key={s.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2">
                        {new Date(s.connected_at).toLocaleString()}
                      </td>
                      <td className="py-2">
                        {isOpen ? (
                          <span className="text-accent-600 font-medium">进行中</span>
                        ) : (
                          new Date(s.disconnected_at!).toLocaleString()
                        )}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {formatDuration(dur)}
                      </td>
                      <td className="py-2 text-right text-ink-light hidden sm:table-cell">
                        {s.remote_ip || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
