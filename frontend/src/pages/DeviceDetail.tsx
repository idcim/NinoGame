import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  Gamepad2,
  Loader2,
  Lock,
  RefreshCw,
  Unlock,
} from "lucide-react";
import { api, ApiError, type CommandRow, type Device } from "../lib/api";

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
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
            <h1 className="text-2xl font-bold text-ink">
              {device?.name || "设备详情"}
            </h1>
            <p className="text-sm text-ink-dim mt-1">
              {device?.platform || "—"} · {device?.device_type || "—"} · 最后在线{" "}
              {device?.last_seen_at
                ? new Date(device.last_seen_at).toLocaleString()
                : "—"}
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
          <div className="text-sm font-semibold mb-2">临时放行 PvZ</div>
          <div className="text-xs text-ink-dim mb-3">
            选择放行时长 (期间 PvZ 不被拦截, 但 token 仍按 1.5 倍率扣)
          </div>
          <div className="flex gap-2 flex-wrap">
            {unlockButtons.map((m) => (
              <button
                key={m}
                onClick={() =>
                  push(
                    "temporary_unlock",
                    { rule_id: "rule_pvz_all", duration_seconds: m * 60 },
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
          <div className="text-sm font-semibold mb-2">其他</div>
          <button
            onClick={() => push("lock_device", {}, "立即锁定")}
            disabled={busy}
            className="btn-ghost"
          >
            <Lock size={14} />
            立即锁定设备
          </button>
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
    </section>
  );
}

function CommandRowView({ cmd }: { cmd: CommandRow }) {
  const typeLabel: Record<string, string> = {
    temporary_unlock: "临时解锁",
    lock_device: "立即锁定",
    start_free_pass: "开启限免",
    end_free_pass: "结束限免",
    request_status: "请求状态",
    request_photo: "请求拍照",
  };
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
          {typeLabel[cmd.command_type] || cmd.command_type}
          {isUnlock && dur > 0 && (
            <span className="text-ink-dim font-normal ml-2">
              <Clock size={12} className="inline mr-1" />
              {Math.round(dur / 60)} 分钟
            </span>
          )}
        </div>
        <div className="text-xs text-ink-light mt-0.5">
          {new Date(cmd.created_at).toLocaleString()} · {cmd.status}
        </div>
      </div>
    </div>
  );
}
