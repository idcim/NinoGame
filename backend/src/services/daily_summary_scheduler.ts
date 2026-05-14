/** 每日总结推送 (v0.4.7, P4 之外的高杠杆补完).
 *
 * 每天 21:00 (server local tz, 默认 Asia/Shanghai) 给每位 parent 的每个有今日
 * 活动的孩子推一条"今日 Nino 总结"通知 — 闭环 CLAUDE.md §15 可见性.
 * 完全复用 v0.4.1 notifier (企微 + SMTP), info 级.
 *
 * 摘要包含 (从 app_sessions / token_ledger 聚合):
 *   - 今日 active 时长 (HH 小时 MM 分)
 *   - 净 token 变化 (+/-)
 *   - 扣分明细 (玩耍 / 申请预扣 ...) + 挣分明细 (任务 / 家长发奖 ...)
 *   - 时长最多的 Top 1 应用
 *
 * 防爆:
 *   - dedupe_key=daily:CHILD_ID:YYYY-MM-DD → 同日重启 server 也不重发
 *   - 没活动 (active_seconds=0) 跳过 — 别为"今天孩子根本没用"也发
 *
 * 配置:
 *   - admin_settings.daily_summary.enabled (default false) — opt-in
 *   - admin_settings.daily_summary.time (default '21:00', "HH:MM") — 触发时刻
 *   - 每分钟检查一次本地时间, 命中目标分钟即触发该日批次
 *
 * 待 admin UI 加 (这版 backend 先就绪).
 */
import type { FastifyBaseLogger } from "fastify";
import { pool } from "../db.js";
import { getSetting } from "./admin_settings.js";
import { notify } from "./notifier/index.js";

const CHECK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 30_000;

export interface DailySummaryConfig {
  enabled?: boolean;
  time?: string; // "HH:MM"
}

let timer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;
let lastFiredDate: string = ""; // 防同一分钟内重入

function currentHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatActiveDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h} 小时 ${remM} 分` : `${h} 小时`;
}

interface ChildSummary {
  child_id: string;
  display_name: string;
  parent_id: string;
  active_seconds: number;
  net_delta: number;
  earned: number;
  consumed: number;
  top_app: string | null;
  top_app_minutes: number;
}

/** 拉今日所有 (有活动) 孩子的摘要数据. */
async function fetchTodaySummaries(): Promise<ChildSummary[]> {
  const r = await pool.query<{
    child_id: string;
    display_name: string;
    parent_id: string;
    active_seconds: string;
    net_delta: string;
    earned: string;
    consumed: string;
    top_app: string | null;
    top_app_seconds: string | null;
  }>(
    `WITH today_sessions AS (
       SELECT child_id,
              SUM(active_seconds)::int AS active_seconds
         FROM "NinoGame".app_sessions
        WHERE started_at::date = CURRENT_DATE
        GROUP BY child_id
     ),
     today_ledger AS (
       SELECT w.child_id,
              SUM(l.delta)::int AS net_delta,
              SUM(GREATEST(l.delta, 0))::int AS earned,
              SUM(GREATEST(-l.delta, 0))::int AS consumed
         FROM "NinoGame".token_ledger l
         JOIN "NinoGame".wallets w ON w.id = l.wallet_id
        WHERE l.occurred_at::date = CURRENT_DATE
        GROUP BY w.child_id
     ),
     today_top_apps AS (
       SELECT DISTINCT ON (child_id)
              child_id, app_identifier, active_seconds
         FROM (
           SELECT child_id,
                  app_identifier,
                  SUM(active_seconds)::int AS active_seconds
             FROM "NinoGame".app_sessions
            WHERE started_at::date = CURRENT_DATE
            GROUP BY child_id, app_identifier
         ) t
        ORDER BY child_id, active_seconds DESC
     )
     SELECT c.id::text AS child_id,
            COALESCE(c.display_name, c.username) AS display_name,
            c.parent_id::text AS parent_id,
            COALESCE(s.active_seconds, 0)::text AS active_seconds,
            COALESCE(l.net_delta, 0)::text AS net_delta,
            COALESCE(l.earned, 0)::text AS earned,
            COALESCE(l.consumed, 0)::text AS consumed,
            ta.app_identifier AS top_app,
            ta.active_seconds::text AS top_app_seconds
       FROM "NinoGame".children c
       LEFT JOIN today_sessions s ON s.child_id = c.id
       LEFT JOIN today_ledger l ON l.child_id = c.id
       LEFT JOIN today_top_apps ta ON ta.child_id = c.id
      WHERE COALESCE(s.active_seconds, 0) > 0`,
  );
  return r.rows.map((row) => ({
    child_id: row.child_id,
    display_name: row.display_name,
    parent_id: row.parent_id,
    active_seconds: Number(row.active_seconds),
    net_delta: Number(row.net_delta),
    earned: Number(row.earned),
    consumed: Number(row.consumed),
    top_app: row.top_app,
    top_app_minutes: row.top_app_seconds ? Math.round(Number(row.top_app_seconds) / 60) : 0,
  }));
}

/** 给一个 child 推今日摘要. */
async function pushOne(logger: FastifyBaseLogger, s: ChildSummary): Promise<void> {
  const date = currentDate();
  const netStr = s.net_delta >= 0 ? `+${s.net_delta}` : `${s.net_delta}`;
  const topPart = s.top_app
    ? `\n时长最多: ${s.top_app} (${s.top_app_minutes} 分钟)`
    : "";

  await notify(logger, {
    severity: "info",
    subject: `今日 ${s.display_name} 总结 · ${date}`,
    body:
      `Active 时长: ${formatActiveDuration(s.active_seconds)}\n` +
      `Token 净变化: ${netStr} (+${s.earned} 挣 / -${s.consumed} 花)` +
      topPart +
      `\n\n详情见家长后台 /reports.`,
    dedupe_key: `daily_summary:${s.child_id}:${date}`,
  });
}

async function runOnce(logger: FastifyBaseLogger): Promise<void> {
  try {
    const cfg = (await getSetting<DailySummaryConfig>("daily_summary")) || {};
    if (!cfg.enabled) return;
    const target = cfg.time || "21:00";
    if (!/^\d{2}:\d{2}$/.test(target)) {
      logger.warn({ target }, "daily_summary: 时间格式错, 跳过");
      return;
    }
    const now = currentHHMM();
    if (now !== target) return;
    // 同分钟内防重入 (1 分钟检查间隔, 误差可能让同一分钟多触发一次)
    const stamp = `${currentDate()} ${target}`;
    if (lastFiredDate === stamp) return;
    lastFiredDate = stamp;

    const summaries = await fetchTodaySummaries();
    logger.info({ count: summaries.length }, "daily_summary tick");
    for (const s of summaries) {
      try {
        await pushOne(logger, s);
      } catch (err) {
        logger.warn({ err, child_id: s.child_id }, "daily_summary push failed");
      }
    }
  } catch (err) {
    logger.warn({ err }, "daily_summary tick error");
  }
}

/** admin "立即触发一次" 用 — 忽略 enabled / time 检查, 直接拉今日数据并推. */
export async function fireSummariesNow(log: FastifyBaseLogger): Promise<{
  pushed: number;
  skipped: number;
  errors: number;
}> {
  let pushed = 0;
  let skipped = 0;
  let errors = 0;
  const summaries = await fetchTodaySummaries();
  for (const s of summaries) {
    try {
      await pushOne(log, s);
      pushed++;
    } catch (err) {
      log.warn({ err, child_id: s.child_id }, "daily_summary manual push failed");
      errors++;
    }
  }
  skipped = 0; // fetchTodaySummaries 已经过滤 0 active
  return { pushed, skipped, errors };
}

export function startDailySummaryScheduler(log: FastifyBaseLogger): void {
  if (timer) return;
  firstRunTimer = setTimeout(() => {
    void runOnce(log);
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runOnce(log);
  }, CHECK_INTERVAL_MS);
  log.info(
    { check_interval_seconds: CHECK_INTERVAL_MS / 1000 },
    "daily summary scheduler started",
  );
}

export function stopDailySummaryScheduler(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
