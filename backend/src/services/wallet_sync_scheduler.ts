/** 周期 wallet sync: server 主动给所有在线 Agent push 当前 server balance,
 *  作为 wallet_update 漏 push 的兜底 (用户报 "server 在扣但 Agent 显示不动").
 *
 *  每 60s 一遍, 对每个 connected agent:
 *    1. 查该 child 的当前 server balance
 *    2. pushToDevice wallet_update {balance, reason:'server_sync'}
 *    3. Agent 端 _apply_server_wallet → sync_balance 把本地拉到 server 值
 *
 *  reason='server_sync' 在 Agent 端是 SILENT_REASONS, 不弹通知, 仅静默对齐 balance。
 */
import type { FastifyBaseLogger } from "fastify";
import { pool } from "../db.js";
import { pushToDevice } from "../ws/agent.js";
import { getConnectedDevices } from "../ws/agent.js";

const INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;

async function runOnce(log: FastifyBaseLogger): Promise<void> {
  const devices = getConnectedDevices();
  if (devices.length === 0) return;

  // 按 child_id group, 一次查多个孩子的 balance
  const childIds = Array.from(new Set(devices.map((d) => d.child_id).filter((x): x is string => Boolean(x))));
  if (childIds.length === 0) return;
  const r = await pool.query<{ child_id: string; balance: number }>(
    `SELECT child_id, balance FROM "NinoGame".wallets WHERE child_id = ANY($1::uuid[])`,
    [childIds],
  );
  const balanceMap = new Map<string, number>();
  for (const row of r.rows) {
    balanceMap.set(row.child_id, Number(row.balance));
  }

  // 每个设备推一次最新 balance
  let pushed = 0;
  for (const d of devices) {
    if (!d.child_id) continue;
    const balance = balanceMap.get(d.child_id);
    if (balance === undefined) continue;
    const ok = pushToDevice(d.device_id, {
      type: "wallet_update",
      payload: { balance, reason: "server_sync", delta: 0 },
    });
    if (ok) pushed++;
  }
  log.debug(
    { connected: devices.length, pushed },
    "wallet sync tick",
  );
}

export function startWalletSyncScheduler(log: FastifyBaseLogger): void {
  if (timer) return;
  firstRunTimer = setTimeout(() => {
    void runOnce(log);
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runOnce(log);
  }, INTERVAL_MS);
  log.info({ interval_seconds: INTERVAL_MS / 1000 }, "wallet sync scheduler started");
}

export function stopWalletSyncScheduler(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
