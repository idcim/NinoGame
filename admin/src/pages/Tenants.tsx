import { useEffect, useState } from "react";
import { KeyRound, Loader2, RefreshCw, Trash2, Users } from "lucide-react";
import { api, ApiError, type TenantRow } from "../lib/api";

export default function Tenants() {
  const [list, setList] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try { const r = await api.listTenants(); setList(r.tenants); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function reset(id: string, username: string) {
    const pwd = prompt(`为 ${username} 设置新密码 (≥6 字符):`);
    if (!pwd) return;
    if (pwd.length < 6) { alert("密码至少 6 字符"); return; }
    try { await api.resetTenantPassword(id, pwd); alert("✓ 已重置"); }
    catch (e) { alert(e instanceof ApiError ? e.message : "重置失败"); }
  }
  async function del(id: string, username: string) {
    if (!confirm(`删除 ${username}? 会 CASCADE 删除该家长名下所有孩子 / 设备 / 钱包 / 规则. 不可恢复!`)) return;
    if (!confirm(`再次确认: 真的删除 ${username} 及所有数据?`)) return;
    try { await api.deleteTenant(id); load(); }
    catch (e) { alert(e instanceof ApiError ? e.message : "删除失败"); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <Users size={22} className="text-brand" />
            家长账号
          </h1>
          <p className="text-sm text-ink-dim mt-1">
            全 server 视角. parents.tenant_id 留接缝, 未来多租户时分组用.
          </p>
        </div>
        <button onClick={load} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      <div className="card divide-y divide-border/60">
        {list.length === 0 && !loading ? (
          <div className="p-8 text-center text-ink-dim text-sm">还没有家长账号</div>
        ) : (
          list.map((t) => (
            <div key={t.id} className="p-3 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{t.username}</span>
                  <span className="text-xs text-ink-light">
                    {t.child_count} 孩子 · {t.device_count} 设备
                  </span>
                  {t.tenant_id && (
                    <span className="badge badge-muted text-[10px]">tenant {t.tenant_id.slice(0, 8)}…</span>
                  )}
                </div>
                <div className="text-xs text-ink-light mt-0.5">
                  注册于 {new Date(t.created_at).toLocaleDateString("zh-CN")}
                  {t.last_seen && ` · 最近活跃 ${new Date(t.last_seen).toLocaleString("zh-CN")}`}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => reset(t.id, t.username)}
                  className="text-xs px-2 py-1 rounded text-brand border border-brand/40 hover:bg-brand/10">
                  <KeyRound size={12} className="inline mr-1" />重置密码
                </button>
                <button onClick={() => del(t.id, t.username)}
                  className="p-2 rounded text-ink-dim hover:text-warn"
                  title="删除 (CASCADE)">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
