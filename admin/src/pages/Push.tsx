import { useEffect, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { api, ApiError, type AdminPushConfig } from "../lib/api";

export default function Push() {
  const [cfg, setCfg] = useState<AdminPushConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { const r = await api.getPush(); setCfg(r.push); }
      catch (e) { setErr(e instanceof ApiError ? e.message : "加载失败"); }
      finally { setLoading(false); }
    })();
  }, []);

  async function save() {
    if (!cfg) return;
    setErr(null); setMsg(null);
    try { const r = await api.savePush(cfg); setCfg(r.push); setMsg("✓ 已保存"); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "保存失败"); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <Bell size={22} className="text-brand" />
          推送通道
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          v0.4.0 仅做配置 + 落库; 实际发送实现在 P5 (notifier 模块)。
        </p>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}
      {msg && <div className="card p-4 text-accent-600 bg-accent/5 border-accent/30">{msg}</div>}
      {loading || !cfg ? (
        <div className="card p-8 text-center text-ink-dim">
          <Loader2 size={20} className="animate-spin mx-auto mb-2" />加载中…
        </div>
      ) : (
        <>
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">企业微信</h2>
            <div className="card p-5 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={cfg.wechat_work.enabled}
                  onChange={(e) => setCfg({ ...cfg, wechat_work: { ...cfg.wechat_work, enabled: e.target.checked } })} />
                启用
              </label>
              <div>
                <label className="label">Webhook URL</label>
                <input className="input font-mono"
                  value={cfg.wechat_work.webhook_url}
                  onChange={(e) => setCfg({ ...cfg, wechat_work: { ...cfg.wechat_work, webhook_url: e.target.value } })}
                  placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." />
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">SMTP (邮件)</h2>
            <div className="card p-5 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={cfg.smtp.enabled}
                  onChange={(e) => setCfg({ ...cfg, smtp: { ...cfg.smtp, enabled: e.target.checked } })} />
                启用
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="label">Host</label>
                  <input className="input font-mono" value={cfg.smtp.host}
                    onChange={(e) => setCfg({ ...cfg, smtp: { ...cfg.smtp, host: e.target.value } })}
                    placeholder="smtp.exmail.qq.com" />
                </div>
                <div>
                  <label className="label">Port</label>
                  <input type="number" className="input" value={cfg.smtp.port}
                    onChange={(e) => setCfg({ ...cfg, smtp: { ...cfg.smtp, port: Number(e.target.value) } })} />
                </div>
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={cfg.smtp.secure}
                    onChange={(e) => setCfg({ ...cfg, smtp: { ...cfg.smtp, secure: e.target.checked } })} />
                  SSL/TLS (端口 465 时勾)
                </label>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="label">用户名</label>
                  <input className="input" value={cfg.smtp.user}
                    onChange={(e) => setCfg({ ...cfg, smtp: { ...cfg.smtp, user: e.target.value } })} />
                </div>
                <div>
                  <label className="label">密码 (留空保留旧值)</label>
                  <input type="password" className="input" value={cfg.smtp.password}
                    onChange={(e) => setCfg({ ...cfg, smtp: { ...cfg.smtp, password: e.target.value } })}
                    placeholder={cfg.smtp.password === "****" ? "(已保存, 留空保留)" : ""} />
                </div>
              </div>
              <div>
                <label className="label">发件人 From</label>
                <input className="input" value={cfg.smtp.from}
                  onChange={(e) => setCfg({ ...cfg, smtp: { ...cfg.smtp, from: e.target.value } })}
                  placeholder="NinoGame <noreply@example.com>" />
              </div>
            </div>
          </section>

          <div className="flex justify-end">
            <button onClick={save} className="btn-primary">保存</button>
          </div>
        </>
      )}
    </div>
  );
}
