import { useEffect, useState } from "react";
import { Bell, CalendarClock, Loader2, Zap } from "lucide-react";
import { api, ApiError, type AdminDailySummaryConfig, type AdminPushConfig } from "../lib/api";

export default function Push() {
  const [cfg, setCfg] = useState<AdminPushConfig | null>(null);
  const [daily, setDaily] = useState<AdminDailySummaryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dailyErr, setDailyErr] = useState<string | null>(null);
  const [dailyMsg, setDailyMsg] = useState<string | null>(null);
  const [dailyTriggering, setDailyTriggering] = useState(false);
  const [dailyTriggerResult, setDailyTriggerResult] =
    useState<{ pushed: number; skipped: number; errors: number } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [p, d] = await Promise.all([api.getPush(), api.getDailySummary()]);
        setCfg(p.push);
        setDaily(d.daily_summary);
      }
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

  async function saveDaily() {
    if (!daily) return;
    setDailyErr(null); setDailyMsg(null);
    try { const r = await api.saveDailySummary(daily); setDaily(r.daily_summary); setDailyMsg("✓ 已保存"); }
    catch (e) { setDailyErr(e instanceof ApiError ? e.message : "保存失败"); }
  }

  async function triggerDaily() {
    setDailyTriggering(true); setDailyTriggerResult(null); setDailyErr(null);
    try {
      const r = await api.triggerDailySummary();
      setDailyTriggerResult(r);
    } catch (e) {
      setDailyErr(e instanceof ApiError ? e.message : "触发失败");
    } finally {
      setDailyTriggering(false);
    }
  }

  const [testing, setTesting] = useState<string>("");
  const [testResult, setTestResult] = useState<{ channel: string; ok: boolean; msg: string } | null>(null);
  async function testChannel(channel: "wechat_work" | "smtp") {
    setTesting(channel); setTestResult(null);
    try {
      const r = await api.testPush(channel);
      const sent = r.sent.find((s) => s.channel === channel);
      const skipped = r.skipped.find((s) => s.channel === channel);
      if (sent) {
        setTestResult({ channel, ok: sent.ok, msg: sent.ok ? "已发送, 请去对应客户端确认" : (sent.error || "未知错误") });
      } else if (skipped) {
        setTestResult({ channel, ok: false, msg: `跳过: ${skipped.reason}` });
      } else {
        setTestResult({ channel, ok: false, msg: "无结果 — push 配置全空?" });
      }
    } catch (e) {
      setTestResult({ channel, ok: false, msg: e instanceof ApiError ? e.message : "请求失败" });
    } finally { setTesting(""); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <Bell size={22} className="text-brand" />
          推送通道
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          v0.4.1 起 4 个关键事件 (Agent 升级失败 / PIN 多次错 / 设备掉线 / 行为基线异常) 自动推; v0.4.8 加每日总结。
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
              <div className="flex justify-end">
                <button onClick={() => testChannel("wechat_work")} disabled={testing === "wechat_work" || !cfg.wechat_work.webhook_url} className="btn-ghost text-xs">
                  {testing === "wechat_work" ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  测试发送
                </button>
              </div>
              {testResult?.channel === "wechat_work" && (
                <div className={"text-xs rounded px-2 py-1 " + (testResult.ok ? "text-accent-600 bg-accent/10" : "text-warn bg-warn/10")}>
                  {testResult.ok ? "✓ " : "× "}{testResult.msg}
                </div>
              )}
              <p className="text-xs text-ink-light">
                先填 webhook URL + 勾启用 + 保存, 再点测试. 保存后启用状态生效, 测试只是看连通性.
              </p>
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
              <div className="flex justify-end">
                <button onClick={() => testChannel("smtp")} disabled={testing === "smtp" || !cfg.smtp.host || !cfg.smtp.from} className="btn-ghost text-xs">
                  {testing === "smtp" ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  测试发送
                </button>
              </div>
              {testResult?.channel === "smtp" && (
                <div className={"text-xs rounded px-2 py-1 " + (testResult.ok ? "text-accent-600 bg-accent/10" : "text-warn bg-warn/10")}>
                  {testResult.ok ? "✓ " : "× "}{testResult.msg}
                </div>
              )}
              <p className="text-xs text-ink-light">
                收件人默认是 SMTP user 自己 (admin 邮箱); 先保存后再测.
              </p>
            </div>
          </section>

          <div className="flex justify-end">
            <button onClick={save} className="btn-primary">保存推送通道</button>
          </div>

          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
              <CalendarClock size={16} className="text-brand" />
              每日总结推送
            </h2>
            <div className="card p-5 space-y-3">
              <p className="text-xs text-ink-dim leading-relaxed">
                每天到点把每个孩子今日活动 (active 时长 / token 净变化 / Top 应用) 推一条到企微 + SMTP — 走上面配的同一通道。
                没活动的孩子不发, 重启 server 同日不重发 (dedupe_key=daily_summary:CHILD:DATE)。
              </p>
              {daily && (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={daily.enabled}
                      onChange={(e) => setDaily({ ...daily, enabled: e.target.checked })} />
                    启用每日总结推送
                  </label>
                  <div>
                    <label className="label">触发时刻 (HH:MM, server 本地时区)</label>
                    <input className="input font-mono w-32" value={daily.time}
                      onChange={(e) => setDaily({ ...daily, time: e.target.value })}
                      placeholder="21:00" />
                    <p className="text-xs text-ink-light mt-1">
                      建议晚饭后 / 睡前 (例 21:00). 每分钟检查一次, 命中目标分钟即触发该日批次.
                    </p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={triggerDaily}
                      disabled={dailyTriggering}
                      className="btn-ghost text-xs">
                      {dailyTriggering ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                      立即触发一次 (测试)
                    </button>
                    <button onClick={saveDaily} className="btn-primary text-sm">保存每日总结</button>
                  </div>
                  {dailyMsg && (
                    <div className="text-xs rounded px-2 py-1 text-accent-600 bg-accent/10">{dailyMsg}</div>
                  )}
                  {dailyErr && (
                    <div className="text-xs rounded px-2 py-1 text-warn bg-warn/10">{dailyErr}</div>
                  )}
                  {dailyTriggerResult && (
                    <div className={"text-xs rounded px-2 py-1 " +
                      (dailyTriggerResult.errors > 0 ? "text-warn bg-warn/10" : "text-accent-600 bg-accent/10")}>
                      {dailyTriggerResult.errors > 0 ? "△ " : "✓ "}
                      推送 {dailyTriggerResult.pushed} 条
                      {dailyTriggerResult.errors > 0 ? `, 失败 ${dailyTriggerResult.errors} 条` : ""}
                      {dailyTriggerResult.pushed === 0 ? " — 今日所有孩子 active=0, 没东西可发" : ""}
                    </div>
                  )}
                  <p className="text-xs text-ink-light">
                    要先把上面的企微 / SMTP 通道配好 + 保存 + 测过, 这里启用才有效。
                  </p>
                </>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
