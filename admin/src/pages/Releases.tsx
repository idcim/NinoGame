import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { api, ApiError, type AgentRelease } from "../lib/api";

/** Agent 升级包管理 (CLAUDE.md §17 无感更新). v0.4.0+ 归 admin 后台.
 *
 * 流程:
 *   1. Admin 把 zip (PyInstaller 打包好的 onedir 压缩) + version 填进表单
 *   2. 上传后落 agent_releases 表 (+ storage 驱动落地: local/S3/OSS), 但不立刻发布
 *   3. 检查 sha256 / 大小 OK 后, 点 "设为目标" → 所有落后 Agent hello 时
 *      会拿到 update_self 命令, 等孩子 lock 态自动升级
 *   4. 旧 release 可以删 (除了当前 target; 同步删除存储后端的文件)
 */
export default function Releases() {
  const [list, setList] = useState<AgentRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listReleases();
      setList(r.releases);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <Package size={22} className="text-brand" />
            Agent 升级包
          </h1>
          <p className="text-sm text-ink-dim mt-1">
            上传 zip → 设为目标版本 → 所有落后 Agent 自动在 Lock 态升级
          </p>
        </div>
        <button onClick={load} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      <UploadCard onUploaded={load} />

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      <section>
        <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
          已上传 ({list.length})
        </h2>
        <div className="card divide-y divide-border/60">
          {list.length === 0 && !loading ? (
            <div className="p-8 text-center text-ink-dim text-sm">
              还没有 release。上传第一个 zip 试试。
            </div>
          ) : (
            list.map((r) => (
              <ReleaseRow key={r.id} release={r} onChanged={load} />
            ))
          )}
        </div>
      </section>

      <section className="text-xs text-ink-light space-y-1 leading-relaxed">
        <p>· Agent 端检测到 update_self 命令后会等孩子 Lock 态 (闲置自动锁屏 / 关机准备等) 才动手, 不打断当前使用</p>
        <p>· 升级失败会自动回滚, 同一版本 6 小时内不再重试</p>
        <p>· 一次性: v0.2.0 升级到 v0.3.0 还要手动重装一次 (旧版本没带 Updater); v0.3.0 起所有版本自动升</p>
      </section>
    </div>
  );
}

function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !version.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.uploadRelease(file, version.trim(), notes.trim());
      setFile(null);
      setVersion("");
      setNotes("");
      const input = document.getElementById("release-file") as HTMLInputElement | null;
      if (input) input.value = "";
      onUploaded();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="text-sm font-semibold text-ink flex items-center gap-1.5">
        <Upload size={14} className="text-brand" />
        上传新版本
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <label className="label">zip 文件 (PyInstaller onedir 压缩)</label>
          <input
            id="release-file"
            type="file"
            accept=".zip"
            className="input"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
            disabled={busy}
          />
          {file && (
            <div className="text-xs text-ink-light mt-1">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </div>
          )}
        </div>
        <div>
          <label className="label">版本号 (x.y.z)</label>
          <input
            className="input font-mono"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="0.3.0"
            pattern="\d+\.\d+\.\d+"
            required
            disabled={busy}
          />
        </div>
      </div>
      <div>
        <label className="label">备注 (可选)</label>
        <input
          className="input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="例: 修锁屏闪烁 + 加无感更新"
          maxLength={1024}
          disabled={busy}
        />
      </div>
      {err && <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">{err}</div>}
      <div className="flex justify-end">
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || !file || !version.trim()}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {busy ? "上传中..." : "上传"}
        </button>
      </div>
    </form>
  );
}

function ReleaseRow({
  release,
  onChanged,
}: {
  release: AgentRelease;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function promote() {
    if (!confirm(`把 v${release.version} 设为目标版本? 落后的 Agent 会在 Lock 态自动升级。`)) return;
    setBusy(true); setErr(null);
    try { await api.promoteRelease(release.id); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function del() {
    if (!confirm(`删除 v${release.version}? 文件也会被删除, 不可恢复。`)) return;
    setBusy(true); setErr(null);
    try { await api.deleteRelease(release.id); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "删除失败"); }
    finally { setBusy(false); }
  }

  const sizeMB = (release.size_bytes / 1024 / 1024).toFixed(1);
  const uploadedAt = new Date(release.uploaded_at).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });

  return (
    <div className="p-3 flex items-center gap-3 flex-wrap">
      <div className={
        "w-10 h-10 rounded-lg flex items-center justify-center shrink-0 " +
        (release.is_target ? "bg-accent/15 text-accent" : "bg-bg-soft text-ink-dim")
      }>
        {release.is_target ? <CheckCircle2 size={18} /> : <Package size={16} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold font-mono">v{release.version}</span>
          {release.is_target && <span className="badge badge-accent">当前目标</span>}
          <span className="text-xs text-ink-light">{sizeMB} MB · {uploadedAt}</span>
        </div>
        {release.notes && (
          <div className="text-xs text-ink-dim mt-0.5 truncate">{release.notes}</div>
        )}
        <div className="text-[10px] font-mono text-ink-light mt-0.5 truncate" title={release.sha256}>
          sha256: {release.sha256}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!release.is_target && (
          <button
            onClick={promote}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded text-brand border border-brand/40 hover:bg-brand/10"
          >
            设为目标
          </button>
        )}
        <button
          onClick={del}
          disabled={busy || release.is_target}
          className="p-2 rounded text-ink-dim hover:text-warn disabled:opacity-30 disabled:cursor-not-allowed"
          title={release.is_target ? "不能删当前目标版本" : "删除"}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {err && (
        <div className="w-full text-xs text-warn">{err}</div>
      )}
    </div>
  );
}
