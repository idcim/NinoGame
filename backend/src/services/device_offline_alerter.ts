/** 设备掉线告警 (CLAUDE.md §11.3): Agent last_seen_at 距今 >10 分钟时推家长.
 *
 * 算法:
 *   - 每 OFFLINE_CHECK_INTERVAL_MS (2 分钟) 扫一次
 *   - 候选: devices.agent_token IS NOT NULL (已配对) AND
 *           last_seen_at BETWEEN now-1h AND now-10min
 *           (now-1h 之外的不告警: 旧设备早就不用了或已经停产, 别一直炸)
 *   - 同一 device 同一小时内只发一次 (dedupe_key 含小时 bucket)
 *
 * 不持久化告警状态; notifier 内存 LRU + 小时 bucket 足够防爆.
 */
import type { FastifyBaseLogger } from "fastify";
import { pool } from "../db.js";
import { notify } from "./notifier/index.js";

const INTERVAL_MS = 2 * 60 * 1000;          // 2 分钟
const STARTUP_DELAY_MS = 30 * 1000;          // 启动 30s 后跑首次
const OFFLINE_THRESHOLD_MINUTES = 10;
const STALE_HORIZON_MINUTES = 60;            // 不告 1 小时前就掉的, 那是长期下线

let timer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;

interface OfflineRow {
  device_id: string;
  device_name: string | null;
  child_name: string | null;
  last_seen_at: string;
  minutes_offline: string;
}

async function runOnce(log: FastifyBaseLogger): Promise<void> {
  try {
    const r = await pool.query<OfflineRow>(
      `SELECT d.id AS device_id, d.name AS device_name,
              ch.display_name AS child_name,
              d.last_seen_at::text AS last_seen_at,
              EXTRACT(EPOCH FROM (NOW() - d.last_seen_at))::int / 60 AS minutes_offline
         FROM "NinoGame".devices d
         LEFT JOIN "NinoGame".device_bindings b ON b.device_id = d.id AND b.unbound_at IS NULL
         LEFT JOIN "NinoGame".children ch ON ch.id = b.child_id
        WHERE d.agent_token IS NOT NULL
          AND d.last_seen_at IS NOT NULL
          AND d.last_seen_at < NOW() - ($1 || ' minutes')::interval
          AND d.last_seen_at > NOW() - ($2 || ' minutes')::interval`,
      [OFFLINE_THRESHOLD_MINUTES, STALE_HORIZON_MINUTES],
    );
    if (r.rows.length === 0) {
      log.debug("device offline scan: clean");
      return;
    }
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    for (const row of r.rows) {
      const childPart = row.child_name ? `${row.child_name} 的` : "";
      const namePart = row.device_name || row.device_id.slice(0, 8);
      void notify(log, {
        severity: "warn",
        subject: `${childPart}设备掉线`,
        body: `设备 ${namePart} 已离线 ${row.minutes_offline} 分钟 (最后心跳 ${row.last_seen_at}).\nAgent 可能崩了 / 网络断了 / 孩子关机.`,
        dedupe_key: `device_offline:${row.device_id}:${hourBucket}`,
      }).catch(() => undefined);
    }
    log.info({ offline_count: r.rows.length }, "device offline alerts processed");
  } catch (err) {
    log.warn({ err }, "device offline scan failed");
  }
}

export function startDeviceOfflineAlerter(log: FastifyBaseLogger): void {
  if (timer) return;
  firstRunTimer = setTimeout(() => { void runOnce(log); }, STARTUP_DELAY_MS);
  timer = setInterval(() => { void runOnce(log); }, INTERVAL_MS);
  log.info(
    { interval_minutes: INTERVAL_MS / 60_000, threshold_minutes: OFFLINE_THRESHOLD_MINUTES },
    "device offline alerter started",
  );
}

export function stopDeviceOfflineAlerter(): void {
  if (firstRunTimer) { clearTimeout(firstRunTimer); firstRunTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
