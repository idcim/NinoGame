import { useEffect, useState } from "react";
import { BarChart3, Loader2 } from "lucide-react";
import { api, ApiError, type AdminSystemView, type AgentRelease, type TenantRow } from "../lib/api";

export default function Dashboard() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [releases, setReleases] = useState<AgentRelease[]>([]);
  const [system, setSystem] = useState<AdminSystemView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [t, r, s] = await Promise.all([
          api.listTenants(),
          api.listReleases(),
          api.getSystem(),
        ]);
        setTenants(t.tenants);
        setReleases(r.releases);
        setSystem(s);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const target = releases.find((r) => r.is_target);
  const totalDevices = tenants.reduce((sum, t) => sum + t.device_count, 0);
  const totalChildren = tenants.reduce((sum, t) => sum + t.child_count, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
        <BarChart3 size={22} className="text-brand" />
        概览
      </h1>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}
      {loading && (
        <div className="card p-8 text-center text-ink-dim">
          <Loader2 size={20} className="animate-spin mx-auto mb-2" />
          加载中…
        </div>
      )}

      {!loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label="家长账号" value={tenants.length} />
            <Card label="孩子" value={totalChildren} />
            <Card label="设备 (Agent)" value={totalDevices} />
            <Card label="升级包" value={releases.length} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="card p-4">
              <div className="text-xs text-ink-light mb-1">当前目标 Agent 版本</div>
              <div className="text-xl font-bold text-ink">
                {target ? `v${target.version}` : "(未设置)"}
              </div>
              {target && (
                <div className="text-xs text-ink-dim mt-1">
                  {(target.size_bytes / 1024 / 1024).toFixed(1)} MB · sha256{" "}
                  {target.sha256.slice(0, 12)}…
                </div>
              )}
            </div>
            <div className="card p-4">
              <div className="text-xs text-ink-light mb-1">存储驱动</div>
              <div className="text-xl font-bold text-ink font-mono">
                {system?.storage.driver ?? "?"}
              </div>
              {system?.storage.warning && (
                <div className="text-xs text-warn mt-1">{system.storage.warning}</div>
              )}
            </div>
          </div>

          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
              家长账号 ({tenants.length})
            </h2>
            <div className="card divide-y divide-border/60">
              {tenants.length === 0 ? (
                <div className="p-6 text-center text-ink-dim text-sm">还没有家长账号</div>
              ) : (
                tenants.map((t) => (
                  <div key={t.id} className="p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold">{t.username}</span>
                      <span className="text-xs text-ink-light ml-2">
                        {t.child_count} 孩子 · {t.device_count} 设备
                      </span>
                    </div>
                    <span className="text-xs text-ink-light">
                      {new Date(t.created_at).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-light">{label}</div>
      <div className="text-2xl font-bold text-ink mt-1">{value}</div>
    </div>
  );
}
