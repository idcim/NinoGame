/** 行为基线异常告警的定时器。
 *
 * 每 INTERVAL_MS 跑一次 scanAllChildrenBaseline。启动 + 关闭由 server.ts 调用。
 *
 * 之所以用 setInterval 而不是 cron: P2 单进程, 不引入新依赖, 也不需要"凌晨 4 点"
 * 这种精确时刻。每小时扫一次就够; behavior_anomaly 有 24h cooldown 自带防爆。
 */
import type { FastifyBaseLogger } from "fastify";
import { scanAllChildrenBaseline } from "./behavior_baseline.js";

const INTERVAL_MS = 60 * 60 * 1000; // 60 分钟
const STARTUP_DELAY_MS = 30 * 1000; // 启动 30s 后跑首次, 避开冷启高峰

let timer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;

async function runOnce(log: FastifyBaseLogger): Promise<void> {
  try {
    const r = await scanAllChildrenBaseline();
    if (r.anomalies_triggered > 0) {
      log.warn(
        { children: r.children_scanned, anomalies: r.anomalies_triggered },
        "behavior baseline scan: anomalies detected",
      );
    } else {
      log.debug(
        { children: r.children_scanned },
        "behavior baseline scan: clean",
      );
    }
  } catch (err) {
    log.warn({ err }, "behavior baseline scan failed");
  }
}

export function startBehaviorBaselineScheduler(log: FastifyBaseLogger): void {
  if (timer) return;
  firstRunTimer = setTimeout(() => {
    void runOnce(log);
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runOnce(log);
  }, INTERVAL_MS);
  log.info(
    { interval_minutes: INTERVAL_MS / 60_000, first_run_in_seconds: STARTUP_DELAY_MS / 1000 },
    "behavior baseline scheduler started",
  );
}

export function stopBehaviorBaselineScheduler(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
