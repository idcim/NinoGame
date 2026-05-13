import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Baby,
  Check,
  Copy,
  Gem,
  Loader2,
  Minus,
  Monitor,
  Plus,
  RefreshCw,
  RotateCw,
  TabletSmartphone,
  Trash2,
} from "lucide-react";
import { api, ApiError, type Child, type Device } from "../lib/api";
import EventFeed from "../components/EventFeed";
import {
  deviceTypeLabel,
  maturityLabel,
  onlineLabel,
  platformLabel,
  timeAgo,
} from "../lib/labels";

export default function Dashboard() {
  const [children, setChildren] = useState<Child[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [c, d] = await Promise.all([api.listChildren(), api.listDevices()]);
      setChildren(c.children);
      setDevices(d.devices);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">概览</h1>
          <p className="text-sm text-ink-dim mt-1">
            管理孩子的设备 + token 余额 + 远程命令
          </p>
        </div>
        <button onClick={load} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      {err && (
        <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>
      )}

      <ChildrenSection
        children={children}
        loading={loading}
        onChanged={load}
      />

      <DevicesSection
        devices={devices}
        children={children}
        loading={loading}
        onChanged={load}
      />

      <EventFeed />
    </div>
  );
}

function ChildrenSection({
  children,
  loading,
  onChanged,
}: {
  children: Child[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <section>
      <SectionHeader
        icon={<Baby size={18} className="text-brand" />}
        title="孩子"
        count={children.length}
        action={
          <button onClick={() => setShowAdd(true)} className="btn-ghost text-sm">
            <Plus size={14} />
            新增
          </button>
        }
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {children.length === 0 && !loading && (
          <div className="card p-8 text-center text-ink-dim col-span-full">
            还没有孩子。点右上角"新增"创建。
          </div>
        )}
        {children.map((c) => (
          <ChildCard key={c.id} child={c} onChanged={onChanged} />
        ))}
      </div>
      {showAdd && <AddChildDialog onClose={() => setShowAdd(false)} onDone={onChanged} />}
    </section>
  );
}

function ChildCard({ child, onChanged }: { child: Child; onChanged: () => void }) {
  const [showGrant, setShowGrant] = useState(false);
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className="w-12 h-12 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center">
        <Baby size={24} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold">{child.display_name || child.username}</span>
          <span className="badge badge-info">{maturityLabel(child.maturity_mode)}</span>
        </div>
        <div className="text-xs text-ink-dim mt-0.5 flex items-center gap-2 flex-wrap">
          <span>@{child.username} · {child.birth_year ?? "—"} 生</span>
          <TrustStars level={child.trust_level} />
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="flex items-center justify-end gap-1.5 text-brand font-bold text-xl">
          <Gem size={18} />
          {child.balance}
        </div>
        <div className="text-xs text-ink-dim">token</div>
        <button
          onClick={() => setShowGrant(true)}
          className="text-xs text-brand hover:underline mt-1"
        >
          调账 / 发奖
        </button>
      </div>
      {showGrant && (
        <GrantDialog
          child={child}
          onClose={() => setShowGrant(false)}
          onDone={() => {
            setShowGrant(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function GrantDialog({
  child, onClose, onDone,
}: { child: Child; onClose: () => void; onDone: () => void }) {
  const [delta, setDelta] = useState<number>(30);
  const [reason, setReason] = useState<"parent_grant" | "adjustment" | "task_reward">(
    "parent_grant",
  );
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (delta === 0) {
      setErr("数额不能为 0");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.adjustWallet(child.id, { delta, reason, comment: comment || undefined });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "失败");
    } finally {
      setBusy(false);
    }
  }

  const presets = [10, 30, 50, 100];

  return (
    <div
      className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="card p-6 w-full max-w-md space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-lg flex items-center gap-2">
          <Gem size={18} className="text-brand" />
          {delta >= 0 ? "发 token" : "扣 token"} · {child.display_name || child.username}
        </h3>

        <div>
          <label className="label">数额 (正数=发, 负数=扣)</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDelta(delta * -1)}
              className="btn-ghost text-xs"
              title="正负号切换"
            >
              {delta >= 0 ? "+" : "−"}
            </button>
            <input
              type="number"
              className="input flex-1"
              value={delta}
              onChange={(e) => setDelta(Number(e.target.value || 0))}
              min={-500}
              max={500}
              required
            />
          </div>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {presets.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setDelta(v)}
                className={
                  "text-xs px-2 py-1 rounded border " +
                  (delta === v ? "border-brand text-brand-600 bg-brand-50" : "border-border text-ink-dim hover:text-ink")
                }
              >
                +{v}
              </button>
            ))}
            {presets.map((v) => (
              <button
                key={`m${v}`}
                type="button"
                onClick={() => setDelta(-v)}
                className={
                  "text-xs px-2 py-1 rounded border " +
                  (delta === -v ? "border-warn text-warn bg-warn/10" : "border-border text-ink-dim hover:text-ink")
                }
              >
                −{v}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">类型</label>
          <select
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
          >
            <option value="parent_grant">家长酌赠 (§8.5)</option>
            <option value="task_reward">任务奖励</option>
            <option value="adjustment">调账 (例: 退还误扣)</option>
          </select>
        </div>

        <div>
          <label className="label">备注 (可选, 孩子可见)</label>
          <input
            className="input"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={256}
            placeholder="例: 这周作业完成得不错"
          />
        </div>

        {err && (
          <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
            {err}
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="btn-ghost" disabled={busy}>
            取消
          </button>
          <button
            type="submit"
            className={delta >= 0 ? "btn-primary" : "btn-warn"}
            disabled={busy}
          >
            {delta >= 0 ? <Plus size={14} /> : <Minus size={14} />}
            {busy ? "处理中..." : `${delta >= 0 ? "发放" : "扣除"} ${Math.abs(delta)} token`}
          </button>
        </div>
      </form>
    </div>
  );
}

function TrustStars({ level }: { level: number }) {
  const lvl = Math.max(0, Math.min(5, level | 0));
  return (
    <span
      className="inline-flex items-center text-accent-600"
      title={`信任值 Lv ${lvl}`}
    >
      {"★".repeat(lvl)}
      <span className="text-ink-light">{"☆".repeat(5 - lvl)}</span>
    </span>
  );
}

function DevicesSection({
  devices,
  children,
  loading,
  onChanged,
}: {
  devices: Device[];
  children: Child[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [showPair, setShowPair] = useState(false);
  const idToChildName = new Map(children.map((c) => [c.id, c.display_name || c.username]));

  return (
    <section>
      <SectionHeader
        icon={<Monitor size={18} className="text-brand" />}
        title="设备"
        count={devices.length}
        action={
          children.length > 0 ? (
            <button onClick={() => setShowPair(true)} className="btn-ghost text-sm">
              <Plus size={14} />
              生成配对码
            </button>
          ) : null
        }
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {devices.length === 0 && !loading && (
          <div className="card p-8 text-center text-ink-dim col-span-full">
            还没有设备。给孩子的电脑生成配对码 → 运行 <code>agent/pair.py</code> 兑换。
          </div>
        )}
        {devices.map((d) => (
          <Link
            key={d.id}
            to={`/device/${d.id}`}
            className="card p-5 hover:shadow-lg transition-shadow"
          >
            <div className="flex items-start gap-3">
              <div className="relative w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
                {d.platform === "windows" ? <Monitor size={20} /> : <TabletSmartphone size={20} />}
                {/* 在线/离线小圆点, 右下角 */}
                <span
                  className={
                    "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bg-card " +
                    (d.online ? "bg-accent" : "bg-ink-light")
                  }
                  title={onlineLabel(!!d.online)}
                />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{d.name || "未命名设备"}</span>
                  {d.paired ? (
                    <span className="badge badge-success">已配对</span>
                  ) : (
                    <span className="badge badge-warn">待配对</span>
                  )}
                  <span
                    className={
                      "text-xs font-medium " +
                      (d.online ? "text-accent-600" : "text-ink-light")
                    }
                  >
                    ● {onlineLabel(!!d.online)}
                  </span>
                </div>
                <div className="text-xs text-ink-dim mt-1 space-y-0.5">
                  <div>归属: {d.child_id ? idToChildName.get(d.child_id) || "—" : "—"}</div>
                  <div>
                    类型: {deviceTypeLabel(d.device_type)} · {platformLabel(d.platform)}
                  </div>
                  <div>
                    最后在线:{" "}
                    {d.online ? (
                      <span className="text-accent-600">现在</span>
                    ) : (
                      timeAgo(d.last_seen_at)
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
      {showPair && (
        <CreatePairDialog
          children={children}
          onClose={() => setShowPair(false)}
          onDone={onChanged}
        />
      )}
    </section>
  );
}

function SectionHeader({
  icon, title, count, action,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide flex items-center gap-2">
        {icon}
        {title}
        <span className="text-ink-light font-normal">({count})</span>
      </h2>
      {action}
    </div>
  );
}

function Modal({
  title, onClose, children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="card p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-lg mb-4">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function AddChildDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [birthYear, setBirthYear] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createChild({
        username: username.trim(),
        display_name: displayName.trim() || undefined,
        birth_year: birthYear ? Number(birthYear) : undefined,
      });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="新增孩子" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">用户名 (英文/数字, 唯一)</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            pattern="[A-Za-z0-9_.\\-]+"
            minLength={2}
            maxLength={32}
            required
            autoFocus
          />
        </div>
        <div>
          <label className="label">昵称 (可选)</label>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
          />
        </div>
        <div>
          <label className="label">出生年份 (可选)</label>
          <input
            type="number"
            className="input"
            value={birthYear}
            onChange={(e) => setBirthYear(e.target.value)}
            min={2000}
            max={2030}
          />
        </div>
        {err && (
          <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
            {err}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="btn-ghost">
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "处理中..." : "创建"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PairCodeResult({ code, onClose }: { code: string; onClose: () => void }) {
  const magicLink = `${window.location.origin}/#pair=${code}`;
  const cliCommand = `python agent/pair.py "${magicLink}"`;
  return (
    <div className="space-y-4">
      <div className="text-center py-2">
        <div className="text-sm text-ink-dim mb-2">把链接粘贴到 Agent 的「重新配对」对话框</div>
        <div className="text-4xl font-mono font-bold text-brand tracking-widest select-all mb-1">
          {code}
        </div>
        <div className="text-xs text-ink-light">30 分钟内有效</div>
      </div>

      <CopyableBox
        label="魔法链接 (粘贴到 Agent 对话框)"
        value={magicLink}
        kind="link"
      />

      <CopyableBox
        label="或: 命令行 (PowerShell)"
        value={cliCommand}
        kind="code"
      />

      <details className="text-xs text-ink-dim">
        <summary className="cursor-pointer hover:text-brand">还有别的办法?</summary>
        <div className="mt-2 pl-3 border-l-2 border-border space-y-1">
          <p>• <b>Agent 端</b>: 托盘菜单 → 「重新配对家长后台」 → 粘贴上面的链接</p>
          <p>• <b>无 GUI 时</b>: 终端跑上面的 python 命令</p>
          <p>• <b>手动</b>: <code>python agent/pair.py {window.location.origin} {code}</code></p>
        </div>
      </details>

      <button onClick={onClose} className="btn-primary w-full justify-center">
        完成
      </button>
    </div>
  );
}

function CopyableBox({
  label,
  value,
  kind,
}: {
  label: string;
  value: string;
  kind: "link" | "code";
}) {
  const [copied, setCopied] = useState(false);
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // older browsers
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <div className="space-y-1">
      <div className="text-xs text-ink-dim">{label}</div>
      <div className="flex items-stretch gap-2">
        <div
          className={
            "flex-1 min-w-0 px-3 py-2 rounded-lg bg-brand-50 text-ink truncate select-all " +
            (kind === "code" ? "font-mono text-xs" : "text-xs")
          }
          title={value}
        >
          {value}
        </div>
        <button
          onClick={doCopy}
          className={
            "px-3 rounded-lg border flex items-center gap-1.5 text-xs whitespace-nowrap transition-colors " +
            (copied
              ? "bg-accent text-white border-accent"
              : "border-border text-ink-dim hover:text-brand hover:border-brand")
          }
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}

function CreatePairDialog({
  children, onClose, onDone,
}: {
  children: Child[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [childId, setChildId] = useState(children[0]?.id || "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createPair(childId, name.trim() || undefined);
      setCode(r.pairing_code);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="生成配对码" onClose={onClose}>
      {!code ? (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">归属孩子</label>
            <select
              className="input"
              value={childId}
              onChange={(e) => setChildId(e.target.value)}
              required
            >
              {children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name || c.username} ({c.username})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">设备名称 (可选)</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如: Nino 的笔记本"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="btn-ghost">
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "处理中..." : "生成"}
            </button>
          </div>
        </form>
      ) : (
        <PairCodeResult code={code} onClose={onClose} />
      )}
    </Modal>
  );
}
