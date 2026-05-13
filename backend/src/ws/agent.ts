/** /ws/agent: 与 Agent.exe 的长连接 (CLAUDE.md §19)。

握手:
  Agent 用 `wss://.../ws/agent?token=<agent_token>` 连接
  Server 校验 token → 接受连接
  Agent 发 {type: "hello", payload: {...}}
  Server 回 {type: "hello_ack", payload: {rules, wallet_balance, pending_commands}}

之后双向:
  Agent → Server:  heartbeat / event / usage_report / unlock_request / unknown_apps
  Server → Agent:  ping / rules_update / wallet_update / command / app_categories_update

本文件先实现 hello / hello_ack 骨架, 后续 message_handler 再分模块。
*/
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { lookupDeviceByToken } from "../routes/devices.js";
import { createUnlockRequestFromAgent } from "../routes/unlock_requests.js";
import { ensureTodayGrant } from "../services/wallet.js";
import { publishToParent } from "./event_bus.js";

interface WsMessage {
  type: string;
  id?: string;
  ts?: string;
  payload?: unknown;
}

interface AgentConnection {
  device_id: string;
  child_id: string | null;
  remote: string;
  connected_at: number;
  socket: import("@fastify/websocket").WebSocket;
}

const _connections = new Map<string, AgentConnection>(); // device_id → meta

export function getConnectedDevices(): Array<Omit<AgentConnection, "socket">> {
  return Array.from(_connections.values()).map(({ socket, ...rest }) => rest);
}

/** 服务端主动推消息到指定设备; 设备没在线返回 false (调用方走 DB pending 兜底)。 */
export function pushToDevice(device_id: string, message: object): boolean {
  const conn = _connections.get(device_id);
  if (!conn) return false;
  try {
    conn.socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export async function registerAgentWebSocket(app: FastifyInstance) {
  // 非 async handler: @fastify/websocket v10 期望同步注册监听器,
  // async 包装会让 socket 在 handler resolve 前没法触发 message 事件
  app.get("/ws/agent", { websocket: true }, (socket, req) => {
    const url = new URL(req.url || "/", "http://x");
    const token = url.searchParams.get("token");
    if (!token) {
      app.log.warn({ ip: req.ip }, "/ws/agent rejected: missing token");
      socket.send(JSON.stringify({ type: "error", payload: { reason: "missing_token" } }));
      socket.close(4001, "missing_token");
      return;
    }

    // 1) 立即装监听器 (不阻塞)。token 验证完成前的消息缓存到队列
    let meta: AgentConnection | null = null;
    const pendingBeforeAuth: WsMessage[] = [];

    const processMessage = (msg: WsMessage): void => {
      if (!meta) {
        pendingBeforeAuth.push(msg);
        return;
      }
      void handleMessage(app, socket, meta, msg).catch((err) => {
        app.log.error({ err, device_id: meta!.device_id }, "ws message handler failed");
      });
    };

    socket.on("message", (raw: Buffer | ArrayBuffer | string) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", payload: { reason: "invalid_json" } }));
        return;
      }
      processMessage(msg);
    });

    socket.on("close", () => {
      if (meta) {
        _connections.delete(meta.device_id);
        app.log.info({ device_id: meta.device_id }, "/ws/agent disconnected");
      }
    });

    socket.on("error", (err: Error) => {
      app.log.warn({ err }, "/ws/agent socket error");
    });

    // background async token validation
    void (async () => {
      const dev = await lookupDeviceByToken(token);
      if (!dev) {
        app.log.warn({ ip: req.ip }, "/ws/agent rejected: invalid token");
        socket.send(JSON.stringify({ type: "error", payload: { reason: "invalid_token" } }));
        socket.close(4002, "invalid_token");
        return;
      }
      meta = {
        device_id: dev.device_id,
        child_id: dev.child_id,
        remote: req.ip,
        connected_at: Date.now(),
        socket,
      };
      _connections.set(dev.device_id, meta);
      app.log.info(
        { device_id: dev.device_id, child_id: dev.child_id },
        "/ws/agent connected",
      );
      pool
        .query(`UPDATE "NinoGame".devices SET last_seen_at = NOW() WHERE id = $1`, [
          dev.device_id,
        ])
        .catch((err: Error) => {
          app.log.warn({ err, device_id: dev.device_id }, "last_seen update failed");
        });

      // replay messages buffered before auth completed
      for (const m of pendingBeforeAuth) {
        void handleMessage(app, socket, meta, m).catch((err) => {
          app.log.error({ err, device_id: meta!.device_id }, "ws message handler failed");
        });
      }
      pendingBeforeAuth.length = 0;
    })();
  });
}

async function handleMessage(
  app: FastifyInstance,
  socket: import("@fastify/websocket").WebSocket,
  meta: AgentConnection,
  msg: WsMessage,
): Promise<void> {
  switch (msg.type) {
    case "hello":
      await onHello(app, socket, meta, msg);
      break;
    case "heartbeat":
      await onHeartbeat(meta, msg);
      break;
    case "event":
      await onEvent(meta, msg);
      break;
    case "usage_report":
      await onUsageReport(app, meta, msg);
      break;
    case "unlock_request":
      await onUnlockRequest(app, meta, msg);
      break;
    default:
      app.log.warn({ device_id: meta.device_id, type: msg.type }, "unknown ws message type");
  }
}

async function onHello(
  app: FastifyInstance,
  socket: import("@fastify/websocket").WebSocket,
  meta: AgentConnection,
  _msg: WsMessage,
): Promise<void> {
  // 0) 服务端先幂等发今日基础 token (Agent 上线触发, 跨午夜也会自动补发)
  if (meta.child_id) {
    try {
      const r = await ensureTodayGrant(meta.child_id);
      if (r.applied > 0) {
        app.log.info(
          { child_id: meta.child_id, applied: r.applied, balance: r.balance },
          "daily grant applied",
        );
      }
    } catch (err) {
      app.log.warn({ err, child_id: meta.child_id }, "ensureTodayGrant failed");
    }
  }

  // 拉规则 + 钱包 + pending commands
  const rulesQuery = meta.child_id
    ? pool.query(
        `SELECT id, name, enabled, spec FROM "NinoGame".rules
          WHERE child_id = $1 AND enabled = TRUE`,
        [meta.child_id],
      )
    : Promise.resolve({ rows: [] });
  const walletQuery = meta.child_id
    ? pool.query<{ balance: number }>(
        `SELECT balance FROM "NinoGame".wallets WHERE child_id = $1`,
        [meta.child_id],
      )
    : Promise.resolve({ rows: [{ balance: 0 }] });
  // 只推过去 1 小时内的 pending 命令; 更老的视为过期 (用户离线太久了,
  // 30 分钟解锁这种命令早已没意义, 不该重新触发)
  const cmdQuery = pool.query(
    `SELECT id, command_type, payload FROM "NinoGame".commands
      WHERE device_id = $1
        AND status = 'pending'
        AND created_at > NOW() - INTERVAL '1 hour'
      ORDER BY created_at`,
    [meta.device_id],
  );

  // 顺手把 1 小时前的 pending 命令标 expired, 不再占空间也不再被任何
  // 查询返回
  void pool.query(
    `UPDATE "NinoGame".commands
        SET status = 'expired'
      WHERE device_id = $1
        AND status = 'pending'
        AND created_at <= NOW() - INTERVAL '1 hour'`,
    [meta.device_id],
  ).catch(() => { /* 后台清理失败不影响主流程 */ });

  const [rules, wallet, cmds] = await Promise.all([rulesQuery, walletQuery, cmdQuery]);
  socket.send(
    JSON.stringify({
      type: "hello_ack",
      payload: {
        device_id: meta.device_id,
        child_id: meta.child_id,
        rules: rules.rows,
        wallet_balance: wallet.rows[0]?.balance ?? 0,
        pending_commands: cmds.rows,
        server_time: new Date().toISOString(),
      },
    }),
  );
  app.log.info(
    { device_id: meta.device_id, rules: rules.rows.length, cmds: cmds.rows.length },
    "hello_ack sent",
  );

  // 关键: 把刚发出去的 pending 命令标 delivered, 防止下次重连又重复推。
  // 不标的话 "每次开都放行 30 分钟" — 老的 unlock 命令一直 pending。
  if (cmds.rows.length > 0) {
    const ids = (cmds.rows as Array<{ id: string }>).map((r) => r.id);
    try {
      await pool.query(
        `UPDATE "NinoGame".commands
            SET status = 'delivered'
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    } catch (err) {
      app.log.warn({ err }, "mark commands delivered failed");
    }
  }
}

async function onUnlockRequest(
  app: FastifyInstance,
  meta: AgentConnection,
  msg: WsMessage,
): Promise<void> {
  const p = (msg.payload || {}) as {
    request_text?: string;
    structured?: Record<string, unknown>;
  };
  const text = String(p.request_text || "").trim();
  if (!text || !meta.child_id) return;
  await createUnlockRequestFromAgent(
    app,
    meta.child_id,
    meta.device_id,
    text,
    p.structured || {},
  );
}

async function onUsageReport(
  app: FastifyInstance,
  meta: AgentConnection,
  msg: WsMessage,
): Promise<void> {
  const p = (msg.payload || {}) as {
    period_start?: string;
    period_end?: string;
    foreground_segments?: Array<{
      app: string;
      category: string;
      rate: number;
      active_seconds: number;
      idle_seconds: number;
      tokens_consumed: number;
    }>;
    segment_count_raw?: number;
  };
  const segments = p.foreground_segments || [];
  if (segments.length === 0 || !meta.child_id) return;

  const startedAt = p.period_start ? new Date(p.period_start) : new Date();
  const endedAt = p.period_end ? new Date(p.period_end) : startedAt;

  // 1) 写 app_sessions 历史
  let inserted = 0;
  let total_tokens_consumed = 0;
  for (const seg of segments) {
    if (!seg.app || !seg.category) continue;
    const tokens = Math.max(0, Math.floor(seg.tokens_consumed || 0));
    try {
      await pool.query(
        `INSERT INTO "NinoGame".app_sessions
           (child_id, device_id, app_identifier, category,
            started_at, ended_at, active_seconds, tokens_consumed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          meta.child_id,
          meta.device_id,
          seg.app,
          seg.category,
          startedAt,
          endedAt,
          Math.max(0, Math.floor(seg.active_seconds || 0)),
          tokens,
        ],
      );
      inserted++;
      total_tokens_consumed += tokens;
    } catch (err) {
      app.log.warn({ err, app: seg.app }, "app_sessions insert failed");
    }
  }

  // 2) server 权威扣钱: 单条聚合 ledger + UPDATE wallets
  //    Agent 本地 ledger 不再有"权威"地位, 只是 cache 显示用;
  //    sync_balance 会把 Agent 本地拉回到 server 算出来的余额。
  if (total_tokens_consumed > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const w = await client.query<{ id: string; balance: number }>(
        `SELECT id, balance FROM "NinoGame".wallets
          WHERE child_id = $1 FOR UPDATE`,
        [meta.child_id],
      );
      if (w.rows.length > 0) {
        const before = Number(w.rows[0].balance);
        const newBalance = Math.max(0, before - total_tokens_consumed);
        const realDelta = newBalance - before; // 负数
        await client.query(
          `INSERT INTO "NinoGame".token_ledger
             (wallet_id, delta, balance_after, reason, occurred_at)
           VALUES ($1, $2, $3, 'app_consumption', NOW())`,
          [w.rows[0].id, realDelta, newBalance],
        );
        await client.query(
          `UPDATE "NinoGame".wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
          [newBalance, w.rows[0].id],
        );
        await client.query("COMMIT");

        // 推 wallet_update 给该 Agent (和这个孩子的其他在线设备)
        const devs = await pool.query<{ id: string }>(
          `SELECT d.id FROM "NinoGame".devices d
             JOIN "NinoGame".device_bindings b ON b.device_id = d.id
            WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
          [meta.child_id],
        );
        for (const d of devs.rows) {
          pushToDevice(d.id, {
            type: "wallet_update",
            payload: {
              balance: newBalance,
              reason: "app_consumption",
              delta: realDelta,
            },
          });
        }
      } else {
        await client.query("ROLLBACK");
      }
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      app.log.warn({ err, child_id: meta.child_id }, "wallet decrement failed");
    } finally {
      client.release();
    }
  }

  app.log.info(
    {
      device_id: meta.device_id,
      child_id: meta.child_id,
      inserted,
      raw: p.segment_count_raw,
      tokens_deducted: total_tokens_consumed,
    },
    "usage_report processed",
  );
}

async function onHeartbeat(meta: AgentConnection, _msg: WsMessage): Promise<void> {
  await pool.query(
    `UPDATE "NinoGame".devices SET last_seen_at = NOW() WHERE id = $1`,
    [meta.device_id],
  );
}

async function onEvent(meta: AgentConnection, msg: WsMessage): Promise<void> {
  const payload = msg.payload as { event_type?: string; payload?: unknown };
  if (!payload?.event_type) return;
  const occurred_at = new Date().toISOString();
  await pool.query(
    `INSERT INTO "NinoGame".events (child_id, device_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [meta.child_id, meta.device_id, payload.event_type, payload.payload ?? {}],
  );

  // 解析孩子的 parent_id, 推到所有该家长打开的浏览器
  if (meta.child_id) {
    try {
      const r = await pool.query<{ parent_id: string }>(
        `SELECT parent_id FROM "NinoGame".children WHERE id = $1`,
        [meta.child_id],
      );
      const parent_id = r.rows[0]?.parent_id;
      if (parent_id) {
        publishToParent({
          parent_id,
          child_id: meta.child_id,
          device_id: meta.device_id,
          event_type: payload.event_type,
          payload: payload.payload ?? {},
          occurred_at,
        });
      }
    } catch {
      // 推送失败不影响事件入库
    }
  }
}
