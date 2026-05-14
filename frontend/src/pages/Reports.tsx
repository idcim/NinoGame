import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
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
import {
  api,
  ApiError,
  type CategoryBreakdownRow,
  type DailyReportRow,
  type Granularity,
  type TopAppRow,
} from "../lib/api";
import { getToken } from "../lib/auth";
import { useChild } from "../lib/childContext";
import { categoryLabel, formatDuration } from "../lib/labels";

// 各 granularity 的"数量"档位预设 (UI 按钮组).
// day:   2 周 / 1 月 / 3 月  → /reports/daily 的常规视野
// week:  4 周 / 8 周 / 12 周 → 一个月到一个季度
// month: 3 月 / 6 月 / 12 月 → 一个季度到一年
const PERIOD_PRESETS: Record<Granularity, number[]> = {
  day:   [14, 30, 90],
  week:  [4, 8, 12],
  month: [3, 6, 12],
};

const GRANULARITY_LABELS: Record<Granularity, string> = {
  day:   "日",
  week:  "周",
  month: "月",
};

const PERIOD_UNIT: Record<Granularity, string> = {
  day:   "天",
  week:  "周",
  month: "月",
};

export default function Reports() {
  const { activeChildId, children: childrenList } = useChild();
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [periods, setPeriods] = useState<number>(14);
  const [daily, setDaily] = useState<DailyReportRow[]>([]);
  // 上一个等长期 (用于"周期对比"卡): granularity=week periods=4 时,
  // 拉 periods=8 然后切前后两段
  const [prevPeriod, setPrevPeriod] = useState<{
    active_seconds: number;
    tokens_consumed: number;
  } | null>(null);
  const [topApps, setTopApps] = useState<TopAppRow[]>([]);
  const [breakdown, setBreakdown] = useState<CategoryBreakdownRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 切 granularity 时把 periods 重置到该 granularity 的中档值
  function onGranularityChange(g: Granularity) {
    setGranularity(g);
    const presets = PERIOD_PRESETS[g];
    setPeriods(presets[Math.floor(presets.length / 2)]);
  }

  // childContext 在 Layout 层做加载, 这里没孩子时只显示提示
  useEffect(() => {
    if (childrenList.length === 0) setLoading(false);
  }, [childrenList.length]);

  async function loadReports() {
    if (!activeChildId) return;
    setLoading(true);
    setErr(null);
    try {
      // 一次拉 2*periods, 前一半算"上一个相同长度期", 后一半显示
      // (例 periods=4 周 → 拉 8 周, 切前 4 / 后 4 比较)
      const expanded = Math.min(
        PERIOD_PRESETS[granularity][PERIOD_PRESETS[granularity].length - 1] * 2,
        periods * 2,
      );
      // top-apps 仍按当前 periods 转 days 估算 (周→7×N, 月→30×N)
      const days = granularity === "day" ? periods
                  : granularity === "week" ? periods * 7
                  : Math.min(90, periods * 30);
      const [d, a, b] = await Promise.all([
        api.getDailyReport(activeChildId, expanded, granularity),
        api.getTopAppsReport(activeChildId, Math.min(90, days), 10),
        api.getCategoryBreakdown(activeChildId, periods, granularity),
      ]);
      // 切前后两段 — server 已按 period_start 升序返
      const total = d.days.length;
      const splitAt = Math.max(0, total - periods);
      const cur = d.days.slice(splitAt);
      const prev = d.days.slice(0, splitAt);
      setDaily(cur);
      if (prev.length > 0) {
        setPrevPeriod({
          active_seconds: prev.reduce((s, r) => s + r.active_seconds, 0),
          tokens_consumed: prev.reduce((s, r) => s + r.tokens_consumed, 0),
        });
      } else {
        setPrevPeriod(null);
      }
      setTopApps(a.apps);
      setBreakdown(b.categories);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载报表失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReports();
  }, [activeChildId, periods, granularity]);

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
            最近 {periods} {PERIOD_UNIT[granularity]} active 时长 + Top 应用排名 + 周期对比
          </p>
        </div>
        <button onClick={loadReports} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      {/* 孩子 + 桶宽 + 数量 选择 */}
      <div className="flex gap-3 flex-wrap items-center">
        <div className="flex items-center gap-1 rounded-md border border-border bg-bg-card p-0.5">
          {(["day", "week", "month"] as Granularity[]).map((g) => (
            <button
              key={g}
              onClick={() => onGranularityChange(g)}
              className={
                "px-3 py-1 rounded text-sm " +
                (g === granularity
                  ? "bg-brand text-white"
                  : "text-ink-dim hover:text-ink")
              }
              title={`按${GRANULARITY_LABELS[g]}聚合`}
            >
              {GRANULARITY_LABELS[g]}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {PERIOD_PRESETS[granularity].map((n) => (
            <button
              key={n}
              onClick={() => setPeriods(n)}
              className={
                "px-3 py-1.5 rounded-md text-sm " +
                (n === periods
                  ? "bg-brand text-white"
                  : "bg-bg-card border border-border text-ink-dim hover:text-ink")
              }
            >
              {n} {PERIOD_UNIT[granularity]}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>
      )}

      {childrenList.length === 0 && !loading && (
        <div className="card p-8 text-center text-ink-dim">
          还没有孩子, 去概览页创建。
        </div>
      )}

      {activeChildId && (
        <>
          {/* 汇总 + 周期对比 */}
          <section className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard
                label={`总 active 时长 (${periods}${PERIOD_UNIT[granularity]})`}
                value={formatDuration(summary.totalActive)}
              />
              <SummaryCard
                label={`${PERIOD_UNIT[granularity]}均 active`}
                value={formatDuration(summary.dailyAvg)}
              />
              <SummaryCard
                label="总扣 token"
                value={`${summary.totalTokens}`}
                icon={<Gem size={14} className="text-warn" />}
              />
              <SummaryCard label="会话段数" value={`${summary.totalSessions}`} />
            </div>
            {prevPeriod && (
              <PeriodCompareCard
                granularity={granularity}
                periods={periods}
                cur={{
                  active_seconds: summary.totalActive,
                  tokens_consumed: summary.totalTokens,
                }}
                prev={prevPeriod}
              />
            )}
            <CategoryBreakdownCard
              periods={periods}
              granularity={granularity}
              rows={breakdown}
            />
          </section>

          {/* 每{桶宽}柱状图 */}
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
              每{GRANULARITY_LABELS[granularity]} active 分钟
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
                          title={
                            granularity === "day"
                              ? `${d.period_start}\n${minutes} 分钟 active\n-${d.tokens_consumed} token\n${d.session_count} 段`
                              : `${d.period_start} ~ ${d.period_end}\n${minutes} 分钟 active\n-${d.tokens_consumed} token\n${d.session_count} 段`
                          }
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
                            {formatPeriodLabel(d.period_start, granularity)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 数据导出 — 用当前视图换算成 days 喂 export API (export 仍只吃 days) */}
          <ExportSection
            child_id={activeChildId}
            days={
              granularity === "day" ? periods
              : granularity === "week" ? periods * 7
              : Math.min(365, periods * 30)
            }
          />

          {/* Top 应用 */}
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
              Top 应用 (最近 {periods} {PERIOD_UNIT[granularity]})
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

/** 类别使用占比卡 (v0.4.5, P4 "屏幕使用时长统计").
 *  app_sessions.category 桶聚, 横向 bar + 百分比. 纯描述性, 不参与扣分决策
 *  (CLAUDE.md §22 #33 后 category 不再影响 token), 但仍是有效的"时间花在哪"信号. */
function CategoryBreakdownCard({
  periods,
  granularity,
  rows,
}: {
  periods: number;
  granularity: Granularity;
  rows: CategoryBreakdownRow[];
}) {
  // 颜色: 消遣 warn (黄) / 学习 accent (绿) / 中性 brand (蓝) / 其它 ink-light
  const COLOR: Record<string, string> = {
    consumption: "bg-warn",
    productive:  "bg-accent",
    neutral:     "bg-brand",
    unknown:     "bg-ink-light",
  };
  const total = rows.reduce((s, r) => s + r.active_seconds, 0);
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-light mb-2 font-medium flex items-center gap-1">
        <Monitor size={11} className="text-brand" />
        类别使用占比 · 本 {periods} {PERIOD_UNIT[granularity]}
        {total === 0 && <span className="text-ink-light"> · 暂无数据</span>}
      </div>
      {total === 0 ? (
        <div className="text-xs text-ink-dim py-2">
          这段时间还没有应用使用记录。Agent 配对后 5 分钟会推一次 usage_report。
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const color = COLOR[r.category] || COLOR.unknown;
            return (
              <div key={r.category}>
                <div className="flex justify-between items-center text-xs mb-1">
                  <span className="text-ink font-medium">{categoryLabel(r.category)}</span>
                  <span className="text-ink-dim font-mono">
                    {formatDuration(r.active_seconds)} · {r.percentage.toFixed(1)}%
                  </span>
                </div>
                <div className="h-2.5 bg-bg-card rounded overflow-hidden border border-border/60">
                  <div
                    className={`h-full ${color} transition-all`}
                    style={{ width: `${Math.max(2, r.percentage)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatPeriodLabel(isoOrDate: string, granularity: Granularity): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  if (granularity === "month") {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  if (granularity === "week") {
    return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  }
  return formatDayLabel(isoOrDate);
}

/** 周期对比卡: 当前 vs 上一个相同长度期 (active 时长 + 扣 token), 显示变化 % + 箭头.
 *  CLAUDE.md §15.5 Forecast / §15.6 周回顾的素材 — 让家长一眼看出"是不是越用越多". */
function PeriodCompareCard({
  granularity,
  periods,
  cur,
  prev,
}: {
  granularity: Granularity;
  periods: number;
  cur: { active_seconds: number; tokens_consumed: number };
  prev: { active_seconds: number; tokens_consumed: number };
}) {
  const unit = PERIOD_UNIT[granularity];
  function pctChange(c: number, p: number): { pct: number; dir: "up" | "down" | "flat" } {
    if (p === 0 && c === 0) return { pct: 0, dir: "flat" };
    if (p === 0) return { pct: 100, dir: "up" };
    const ratio = (c - p) / p;
    if (Math.abs(ratio) < 0.02) return { pct: 0, dir: "flat" };
    return { pct: Math.round(ratio * 100), dir: ratio > 0 ? "up" : "down" };
  }
  const active = pctChange(cur.active_seconds, prev.active_seconds);
  const tokens = pctChange(cur.tokens_consumed, prev.tokens_consumed);

  // active / tokens 都是 "降"对家长更舒服 (孩子用得少 = 好). 固定 down 绿 / up 黄.
  function arrow(dir: "up" | "down" | "flat") {
    if (dir === "flat") {
      return { icon: <ArrowRight size={12} />, cls: "text-ink-light" };
    }
    if (dir === "up") return { icon: <ArrowUp size={12} />, cls: "text-warn" };
    return { icon: <ArrowDown size={12} />, cls: "text-accent-600" };
  }
  const a = arrow(active.dir);
  const t = arrow(tokens.dir);

  return (
    <div className="card p-4">
      <div className="text-xs text-ink-light mb-2 font-medium">
        周期对比 · 本 {periods} {unit} vs 上 {periods} {unit}
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-ink-dim text-xs mb-0.5">Active 时长</div>
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-ink">{formatDuration(cur.active_seconds)}</span>
            <span className={`inline-flex items-center gap-0.5 text-xs ${a.cls}`}>
              {a.icon}
              {active.dir === "flat" ? "持平" : `${active.pct > 0 ? "+" : ""}${active.pct}%`}
            </span>
          </div>
          <div className="text-[11px] text-ink-light">
            上期 {formatDuration(prev.active_seconds)}
          </div>
        </div>
        <div>
          <div className="text-ink-dim text-xs mb-0.5 flex items-center gap-1">
            <Gem size={11} className="text-warn" />
            扣 token
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-ink">{cur.tokens_consumed}</span>
            <span className={`inline-flex items-center gap-0.5 text-xs ${t.cls}`}>
              {t.icon}
              {tokens.dir === "flat" ? "持平" : `${tokens.pct > 0 ? "+" : ""}${tokens.pct}%`}
            </span>
          </div>
          <div className="text-[11px] text-ink-light">上期 {prev.tokens_consumed}</div>
        </div>
      </div>
    </div>
  );
}
