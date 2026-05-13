/** 行为基线异常告警 (CLAUDE.md §16.1 防刷 ④)。
 *
 * 目标: "周三阅读 95min 平时均值 35min" → 推家长一条 待核查 事件。
 *       不阻止使用, 不扣钱, 只是提醒"今天偏离正常"。
 *
 * 算法 (按 child × category):
 *   1. 取过去 BASELINE_DAYS 天每天 active_seconds 总和, 算均值 baseline_avg
 *   2. 要求样本天数 >= MIN_SAMPLE_DAYS (太少不可信, 跳过)
 *   3. 今日累计 today_seconds > ANOMALY_RATIO × baseline_avg
 *      且 today_seconds > ABS_FLOOR_SECONDS (低于绝对值不算异常, 例如均值 5min
 *      时今日 11min 不该报警)
 *      → 触发异常
 *   4. 限频: 24 小时内同一 child+category 只发一次 (查 events 表)
 *
 * 触发后:
 *   - INSERT events (event_type='behavior_anomaly', payload={category, today_seconds,
 *     baseline_avg_seconds, sample_days, ratio})
 *   - publishToParent → 浏览器实时事件流
 *
 * 不阻止: 不 kill 进程, 不扣分。家长自己看着办。
 */
import { pool } from "../db.js";
import { publishToParent } from "../ws/event_bus.js";

const BASELINE_DAYS = 14;
const MIN_SAMPLE_DAYS = 5;        // 14 天里至少 5 天有这种活动
const ANOMALY_RATIO = 2.0;        // 偏离 2x 报警
const ABS_FLOOR_SECONDS = 30 * 60; // 今日至少 30 min 才考虑报警
const COOLDOWN_HOURS = 24;

type CategoryKey = "consumption" | "productive";
const TRACKED_CATEGORIES: CategoryKey[] = ["consumption", "productive"];

interface CategoryAggregate {
  category: CategoryKey;
  today_seconds: number;
  baseline_avg_seconds: number;
  sample_days: number;
}

interface AnomalyHit extends CategoryAggregate {
  ratio: number;
}

/** 拉某 child 今日 + 过去 BASELINE_DAYS 天每天每 category 的 active_seconds 聚合。
 *  分两段查比一次大 GROUP BY 简单且索引友好。
 */
async function fetchAggregates(child_id: string): Promise<CategoryAggregate[]> {
  // 今日累计 (本地时区 = UTC; P2 暂不引入 tz 概念)
  const todayQ = await pool.query<{ category: string; total: string }>(
    `SELECT category, COALESCE(SUM(active_seconds), 0)::text AS total
       FROM "NinoGame".app_sessions
      WHERE child_id = $1
        AND started_at >= DATE_TRUNC('day', NOW())
      GROUP BY category`,
    [child_id],
  );

  // 过去 BASELINE_DAYS 完整天 (排除今天) 每天 sum, 再算均值与有效样本天数
  const baselineQ = await pool.query<{
    category: string;
    avg_seconds: string;
    sample_days: string;
  }>(
    `SELECT category,
            AVG(daily_total)::text AS avg_seconds,
            COUNT(*)::text AS sample_days
       FROM (
         SELECT category,
                DATE_TRUNC('day', started_at) AS d,
                SUM(active_seconds) AS daily_total
           FROM "NinoGame".app_sessions
          WHERE child_id = $1
            AND started_at >= DATE_TRUNC('day', NOW()) - ($2::int || ' days')::interval
            AND started_at <  DATE_TRUNC('day', NOW())
          GROUP BY category, DATE_TRUNC('day', started_at)
       ) AS per_day
      GROUP BY category`,
    [child_id, BASELINE_DAYS],
  );

  const todayMap = new Map<string, number>();
  for (const r of todayQ.rows) todayMap.set(r.category, Number(r.total));

  const baselineMap = new Map<string, { avg: number; days: number }>();
  for (const r of baselineQ.rows) {
    baselineMap.set(r.category, {
      avg: Number(r.avg_seconds),
      days: Number(r.sample_days),
    });
  }

  const out: CategoryAggregate[] = [];
  for (const cat of TRACKED_CATEGORIES) {
    const today = todayMap.get(cat) ?? 0;
    const base = baselineMap.get(cat);
    out.push({
      category: cat,
      today_seconds: today,
      baseline_avg_seconds: base?.avg ?? 0,
      sample_days: base?.days ?? 0,
    });
  }
  return out;
}

/** 同 child+category 24h 内是否已经报警过。 */
async function inCooldown(child_id: string, category: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM "NinoGame".events
        WHERE child_id = $1
          AND event_type = 'behavior_anomaly'
          AND (payload->>'category') = $2
          AND occurred_at >= NOW() - ($3::int || ' hours')::interval
     ) AS exists`,
    [child_id, category, COOLDOWN_HOURS],
  );
  return Boolean(r.rows[0]?.exists);
}

async function getParentId(child_id: string): Promise<string | null> {
  const r = await pool.query<{ parent_id: string }>(
    `SELECT parent_id FROM "NinoGame".children WHERE id = $1`,
    [child_id],
  );
  return r.rows[0]?.parent_id ?? null;
}

/** 对单个 child 跑一次基线检查; 返回触发的异常数。 */
export async function checkChildBaseline(child_id: string): Promise<number> {
  const aggs = await fetchAggregates(child_id);

  const hits: AnomalyHit[] = [];
  for (const a of aggs) {
    if (a.sample_days < MIN_SAMPLE_DAYS) continue;
    if (a.baseline_avg_seconds <= 0) continue;
    if (a.today_seconds < ABS_FLOOR_SECONDS) continue;
    const ratio = a.today_seconds / a.baseline_avg_seconds;
    if (ratio < ANOMALY_RATIO) continue;
    hits.push({ ...a, ratio });
  }

  if (hits.length === 0) return 0;

  let triggered = 0;
  for (const hit of hits) {
    if (await inCooldown(child_id, hit.category)) continue;

    const payload = {
      category: hit.category,
      today_seconds: Math.round(hit.today_seconds),
      today_minutes: Math.round(hit.today_seconds / 60),
      baseline_avg_seconds: Math.round(hit.baseline_avg_seconds),
      baseline_avg_minutes: Math.round(hit.baseline_avg_seconds / 60),
      sample_days: hit.sample_days,
      ratio: Number(hit.ratio.toFixed(2)),
    };

    try {
      await pool.query(
        `INSERT INTO "NinoGame".events (child_id, device_id, event_type, payload)
         VALUES ($1, NULL, 'behavior_anomaly', $2::jsonb)`,
        [child_id, JSON.stringify(payload)],
      );
    } catch {
      // 写库失败就跳过, 下次还会被基线扫到 (没 cooldown 入库)
      continue;
    }

    const parent_id = await getParentId(child_id);
    if (parent_id) {
      publishToParent({
        parent_id,
        child_id,
        device_id: null,
        event_type: "behavior_anomaly",
        payload,
        occurred_at: new Date().toISOString(),
      });
    }
    triggered++;
  }
  return triggered;
}

/** 遍历所有 children 跑基线检查; 用于定时调度。返回总触发次数 + 检查孩子数。 */
export async function scanAllChildrenBaseline(): Promise<{
  children_scanned: number;
  anomalies_triggered: number;
}> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM "NinoGame".children`,
  );
  let triggered = 0;
  for (const c of r.rows) {
    try {
      triggered += await checkChildBaseline(c.id);
    } catch {
      // 单 child 失败不影响其他
    }
  }
  return { children_scanned: r.rows.length, anomalies_triggered: triggered };
}
