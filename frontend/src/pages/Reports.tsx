import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Calendar,
  ClipboardList,
  Download,
  FileJson,
  FileSpreadsheet,
  Gem,
  Loader2,
  Megaphone,
  Monitor,
  RefreshCw,
} from "lucide-react";
import { api, ApiError, type Child, type DailyReportRow, type TopAppRow } from "../lib/api";
import { getToken } from "../lib/auth";
import { categoryLabel, formatDuration } from "../lib/labels";

export default function Reports() {
  const [children, setChildren] = useState<Child[]>([]);
  const [activeChild, setActiveChild] = useState<string>("");
  const [days, setDays] = useState<number>(14);
  const [daily, setDaily] = useState<DailyReportRow[]>([]);
  const [topApps, setTopApps] = useState<TopAppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.listChildren();
        setChildren(c.children);
        if (c.children.length > 0) setActiveChild(c.children[0].id);
        else setLoading(false);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : "加载孩子失败");
        setLoading(false);
      }
    })();
  }, []);

  async function loadReports() {
    if (!activeChild) return;
    setLoading(true);
    setErr(null);
    try {
      const [d, a] = await Promise.all([
        api.getDailyReport(activeChild, days),
        api.getTopAppsReport(activeChild, days, 10),
      ]);
      setDaily(d.days);
      setTopApps(a.apps);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载报表失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReports();
  }, [activeChild, days]);

  // 汇总统计
  const summary = useMemo(() => {
    const totalActive = daily.reduce((sum, d) => sum + d.active_seconds, 0);
    const totalTokens = daily.reduce((sum, d) => sum + d.tokens_consumed, 0);
    const totalSessions = daily.reduce((sum, d) => sum + d.session_count, 0);
    const dailyAvg = daily.length > 0 ? Math.round(totalActive / daily.length) : 0;
    return { totalActive, totalTokens, totalSessions, dailyAvg };
  }, [daily]);

  const maxActive = useMemo(
    () => Math.max(60, ...daily.map((d) => d.active_seconds)),
    [daily],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <BarChart3 size={22} className="text-brand" />
            使用报表
          </h1>
          <p className="text-sm text-ink-dim mt-1">
            最近 {days} 天每天 active 时长 + Top 应用排名
          </p>
        </div>
        <button onClick={loadReports} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      {/* 孩子 + 天数选择 */}
      <div className="flex gap-3 flex-wrap items-center">
        <select
          className="input max-w-xs"
          value={activeChild}
          onChange={(e) => setActiveChild(e.target.value)}
        >
          {children.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name || c.username}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          {[7, 14, 30].map((n) => (
            <button
              key={n}
              onClick={() => setDays(n)}
              className={
                "px-3 py-1.5 rounded-md text-sm " +
                (n === days
                  ? "bg-brand text-white"
                  : "bg-bg-card border border-border text-ink-dim hover:text-ink")
              }
            >
              {n} 天
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>
      )}

      {children.length === 0 && !loading && (
        <div className="card p-8 text-center text-ink-dim">
          还没有孩子, 去概览页创建。
        </div>
      )}

      {activeChild && (
        <>
          {/* 汇总 */}
          <section>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard label="总 active 时长" value={formatDuration(summary.totalActive)} />
              <SummaryCard label="日均 active" value={formatDuration(summary.dailyAvg)} />
              <SummaryCard
                label="总扣 token"
                value={`${summary.totalTokens}`}
                icon={<Gem size={14} className="text-warn" />}
              />
              <SummaryCard label="会话段数" value={`${summary.totalSessions}`} />
            </div>
          </section>

          {/* 每日柱状图 */}
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
              每日 active 分钟
            </h2>
            <div className="card p-5">
              {daily.length === 0 && !loading ? (
                <div className="text-center text-ink-dim py-8 text-sm">
                  这段时间还没有使用记录。Agent 配对后 5 分钟会推一次 usage_report。
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <div className="flex items-end gap-2 h-48 min-w-fit">
                    {daily.map((d) => {
                      const minutes = Math.round(d.active_seconds / 60);
                      const maxMin = Math.max(1, Math.round(maxActive / 60));
                      const heightPct = (minutes / maxMin) * 100;
                      return (
                        <div
                          key={d.date}
                          className="flex flex-col items-center flex-1 min-w-[36px]"
                          title={`${d.date}\n${minutes} 分钟 active\n-${d.tokens_consumed} token\n${d.session_count} 段`}
                        >
                          <div className="text-[10px] text-ink-dim mb-1">
                            {minutes > 0 ? `${minutes}` : ""}
                          </div>
                          <div className="flex-1 w-full flex items-end">
                            <div
                              className="w-full bg-brand rounded-t hover:bg-brand-600 transition-colors"
                              style={{ height: `${Math.max(2, heightPct)}%` }}
                            />
                          </div>
                          <div className="text-[10px] text-ink-light mt-1 font-mono">
                            {formatDayLabel(d.date)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 数据导出 */}
          <ExportSection child_id={activeChild} days={days} />

          {/* Top 应用 */}
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
              Top 应用 (最近 {days} 天)
            </h2>
            <div className="card divide-y divide-border/60">
              {topApps.length === 0 && !loading ? (
                <div className="p-6 text-center text-ink-dim text-sm">没有数据</div>
              ) : (
                topApps.map((a, i) => {
                  const minutes = Math.round(a.total_active_seconds / 60);
                  const maxTotal = Math.max(1, ...topApps.map((x) => x.total_active_seconds));
                  const pct = (a.total_active_seconds / maxTotal) * 100;
                  const friendly = a.display_name && a.display_name.trim().length > 0
                    ? a.display_name
                    : a.app_identifier;
                  const showProcess =
                    a.display_name && a.display_name.trim().length > 0 &&
                    a.display_name !== a.app_identifier;
                  return (
                    <div key={a.app_identifier + a.category} className="p-3 flex items-center gap-3">
                      <span className="text-xs text-ink-light w-6 shrink-0">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-ink truncate" title={a.app_identifier}>
                            {friendly}
                          </span>
                          <span className="badge badge-muted">{categoryLabel(a.category)}</span>
                          {a.sub_type && (
                            <span className="text-xs text-ink-light">{a.sub_type}</span>
                          )}
                          <span className="text-xs text-ink-light">{a.session_count} 段</span>
                        </div>
                        {showProcess && (
                          <div className="text-[11px] font-mono text-ink-light truncate mt-0.5">
                            {a.app_identifier}
                          </div>
                        )}
                        <div className="mt-1 h-1.5 bg-brand-50 rounded overflow-hidden">
                          <div
                            className="h-full bg-brand"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-bold text-ink">{minutes} 分</div>
                        {a.total_tokens > 0 && (
                          <div className="text-xs text-warn">-{a.total_tokens} token</div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** 数据导出区: 5 类 × 2 格式 = 10 个下载入口 (v0.4.3).
 *  CLAUDE.md §1.1 透明可见 — 让家长能把自家数据下下来备份 / 外部分析.
 *
 *  实现细节: fetch 带 Bearer (api 包装吃 JSON, 这里要原始 body 自己 fetch),
 *  Blob URL + 临时 <a download> 触发浏览器下载. 失败时把后端错误消息展示出来,
 *  不直接打开下载的乱码文件.
 */
type ExportKind =
  | "daily"
  | "ledger"
  | "app-sessions"
  | "events"
  | "task-completions";

const EXPORT_KINDS: Array<{
  kind: ExportKind;
  title: string;
  desc: string;
  icon: typeof Gem;
}> = [
  { kind: "daily", title: "每日聚合", desc: "每天 active 时长 + 扣 token + 会话段数", icon: Calendar },
  { kind: "ledger", title: "Token 账本", desc: "完整 ledger (含每分钟玩耍扣费)", icon: Gem },
  { kind: "app-sessions", title: "应用使用时段", desc: "每次前台时段 + 时长", icon: Monitor },
  { kind: "events", title: "事件日志", desc: "拦截/PIN/行为异常等审计事件", icon: Megaphone },
  { kind: "task-completions", title: "任务申报", desc: "孩子申报 + 家长批/拒历史", icon: ClipboardList },
];

function ExportSection({ child_id, days }: { child_id: string; days: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function download(kind: ExportKind, format: "json" | "csv") {
    setBusy(`${kind}:${format}`);
    setErr(null);
    try {
      const url = `/api/children/${child_id}/export/${kind}?format=${format}&days=${days}`;
      const token = getToken();
      const resp = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const d = await resp.json();
          if (d?.message) msg = d.message;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      // 从 Content-Disposition 拿文件名, 拿不到就拼一个
      const cd = resp.headers.get("Content-Disposition") || "";
      const m = /filename="?([^"]+)"?/.exec(cd);
      const filename = m?.[1] || `nino_${kind}_${new Date().toISOString().slice(0, 10)}.${format}`;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
        <Download size={16} className="text-brand" />
        数据导出 ({days} 天范围)
        <span className="text-xs font-normal text-ink-light">
          · 备份 / 外部分析 / 给孩子看数字
        </span>
      </h2>
      {err && (
        <div className="card p-3 mb-3 text-warn bg-warn/5 border-warn/30 text-sm">
          {err}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {EXPORT_KINDS.map(({ kind, title, desc, icon: Icon }) => (
          <div key={kind} className="card p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
              <Icon size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-ink text-sm">{title}</div>
              <div className="text-xs text-ink-dim mt-0.5 truncate">{desc}</div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => download(kind, "csv")}
                disabled={busy !== null}
                className="text-xs px-2.5 py-1.5 rounded border border-border text-ink-dim hover:text-brand hover:border-brand disabled:opacity-50 inline-flex items-center gap-1"
                title="CSV (Excel 可直接打开)"
              >
                {busy === `${kind}:csv` ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <FileSpreadsheet size={12} />
                )}
                CSV
              </button>
              <button
                onClick={() => download(kind, "json")}
                disabled={busy !== null}
                className="text-xs px-2.5 py-1.5 rounded border border-border text-ink-dim hover:text-brand hover:border-brand disabled:opacity-50 inline-flex items-center gap-1"
                title="JSON (脚本/程序可直接吃)"
              >
                {busy === `${kind}:json` ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <FileJson size={12} />
                )}
                JSON
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="text-xs text-ink-light mt-2">
        CSV 带 UTF-8 BOM, Excel 直接打开不乱码 · JSON 含 metadata (导出范围 + 字段顺序 + 行数)
      </div>
    </section>
  );
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-light flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-xl font-bold text-ink mt-1">{value}</div>
    </div>
  );
}

function formatDayLabel(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}-${day}`;
}
