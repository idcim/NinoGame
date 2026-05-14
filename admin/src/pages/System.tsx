import { useEffect, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { api, ApiError, type AdminSystemView } from "../lib/api";

const DRIVER_LABEL: Record<string, string> = {
  local: "本地 fs (Docker 卷)",
  s3: "S3-compatible (AWS / MinIO / R2 / 腾讯 COS / 七牛)",
  aliyun_oss: "阿里云 OSS",
};

export default function System() {
  const [view, setView] = useState<AdminSystemView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { setView(await api.getSystem()); }
      catch (e) { setErr(e instanceof ApiError ? e.message : "加载失败"); }
      finally { setLoading(false); }
    })();
  }, []);

  async function save() {
    if (!view) return;
    setErr(null); setMsg(null);
    try {
      await api.saveSystem(view.system);
      setMsg("✓ 已保存");
    } catch (e) { setErr(e instanceof ApiError ? e.message : "保存失败"); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <Database size={22} className="text-brand" />
          系统
        </h1>
        <p className="text-sm text-ink-dim mt-1">系统级限额 + 当前存储驱动状态</p>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}
      {msg && <div className="card p-4 text-accent-600 bg-accent/5 border-accent/30">{msg}</div>}
      {loading || !view ? (
        <div className="card p-8 text-center text-ink-dim">
          <Loader2 size={20} className="animate-spin mx-auto mb-2" />加载中…
        </div>
      ) : (
        <>
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">存储驱动</h2>
            <div className="card p-5 space-y-2 text-sm">
              <Row label="当前驱动">
                <span className="badge badge-muted">{view.storage.driver}</span>
                <span className="ml-2 text-ink-dim">{DRIVER_LABEL[view.storage.driver]}</span>
              </Row>
              <Row label="状态">
                {view.storage.configured ? (
                  <span className="text-accent-600">✓ 配置完整</span>
                ) : (
                  <span className="text-warn">{view.storage.warning ?? "未完整配置"}</span>
                )}
              </Row>
              {view.storage.driver === "local" && (
                <Row label="本地路径"><code>{view.storage.local.artifactsDir}</code></Row>
              )}
              {view.storage.driver === "s3" && (
                <>
                  <Row label="bucket"><code>{view.storage.s3.bucket}</code></Row>
                  <Row label="region"><code>{view.storage.s3.region}</code></Row>
                  <Row label="endpoint"><code>{view.storage.s3.endpoint}</code></Row>
                </>
              )}
              {view.storage.driver === "aliyun_oss" && (
                <>
                  <Row label="bucket"><code>{view.storage.aliyun_oss.bucket}</code></Row>
                  <Row label="region"><code>{view.storage.aliyun_oss.region}</code></Row>
                  <Row label="endpoint"><code>{view.storage.aliyun_oss.endpoint}</code></Row>
                </>
              )}
            </div>
            <p className="text-xs text-ink-light mt-2">
              驱动通过环境变量 <code>STORAGE_DRIVER</code> + 各自 key 配置, 改后需重启 backend.
              详见 README / docker-compose.
            </p>
          </section>

          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">系统限额</h2>
            <div className="card p-5 space-y-3">
              <div>
                <label className="label">下载 token 有效期 (分钟)</label>
                <input type="number" min={5} max={1440} className="input"
                  value={view.system.download_token_ttl_minutes}
                  onChange={(e) => setView({ ...view, system: { ...view.system, download_token_ttl_minutes: Number(e.target.value) } })} />
                <p className="text-xs text-ink-light mt-1">Agent 下载升级包用; 默认 30 分钟</p>
              </div>
              <div>
                <label className="label">最大上传 MB</label>
                <input type="number" min={10} max={2048} className="input"
                  value={view.system.max_upload_mb}
                  onChange={(e) => setView({ ...view, system: { ...view.system, max_upload_mb: Number(e.target.value) } })} />
                <p className="text-xs text-ink-light mt-1">Admin 上传 Agent zip 上限</p>
              </div>
              <div>
                <label className="label">闲置自动 Lock 默认 (分钟)</label>
                <input type="number" min={1} max={120} className="input"
                  value={view.system.idle_lock_minutes_default}
                  onChange={(e) => setView({ ...view, system: { ...view.system, idle_lock_minutes_default: Number(e.target.value) } })} />
                <p className="text-xs text-ink-light mt-1">新建设备时的默认值; 现有设备不变</p>
              </div>
              <div className="flex justify-end">
                <button onClick={save} className="btn-primary">保存</button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-ink-light w-24 shrink-0">{label}</span>
      <span className="text-ink flex-1">{children}</span>
    </div>
  );
}
