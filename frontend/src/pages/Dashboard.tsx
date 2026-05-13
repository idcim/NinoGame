import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Baby,
  Gem,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  TabletSmartphone,
} from "lucide-react";
import { api, ApiError, type Child, type Device } from "../lib/api";
import EventFeed from "../components/EventFeed";

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
          <div key={c.id} className="card p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center">
              <Baby size={24} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{c.display_name || c.username}</span>
                <span className="badge badge-info">{c.maturity_mode}</span>
              </div>
              <div className="text-xs text-ink-dim mt-0.5">
                @{c.username} · {c.birth_year ?? "—"} 生
              </div>
            </div>
            <div className="text-right">
              <div className="flex items-center justify-end gap-1.5 text-brand font-bold text-xl">
                <Gem size={18} />
                {c.balance}
              </div>
              <div className="text-xs text-ink-dim">token</div>
            </div>
          </div>
        ))}
      </div>
      {showAdd && <AddChildDialog onClose={() => setShowAdd(false)} onDone={onChanged} />}
    </section>
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
              <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
                {d.platform === "windows" ? <Monitor size={20} /> : <TabletSmartphone size={20} />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{d.name || "未命名设备"}</span>
                  {d.paired ? (
                    <span className="badge badge-success">已配对</span>
                  ) : (
                    <span className="badge badge-warn">待配对</span>
                  )}
                </div>
                <div className="text-xs text-ink-dim mt-1 space-y-0.5">
                  <div>归属: {d.child_id ? idToChildName.get(d.child_id) || "—" : "—"}</div>
                  <div>类型: {d.device_type} · {d.platform || "—"}</div>
                  <div>最后在线: {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "从未"}</div>
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
        <div className="space-y-4">
          <div className="text-center py-4">
            <div className="text-sm text-ink-dim mb-2">把这个码输入到 Agent 设备</div>
            <div className="text-4xl font-mono font-bold text-brand tracking-widest select-all">
              {code}
            </div>
            <div className="text-xs text-ink-light mt-2">30 分钟内有效</div>
          </div>
          <div className="bg-brand-50 rounded-lg p-3 text-xs text-ink-dim">
            <p className="font-medium mb-1">Agent 端操作:</p>
            <pre className="text-xs whitespace-pre-wrap">
{`python agent/pair.py ${window.location.origin} ${code}`}
            </pre>
          </div>
          <button onClick={onClose} className="btn-primary w-full justify-center">
            完成
          </button>
        </div>
      )}
    </Modal>
  );
}
