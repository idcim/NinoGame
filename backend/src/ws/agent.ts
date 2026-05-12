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
      // TODO: implement aggregation into app_sessions
      app.log.debug({ device_id: meta.device_id }, "usage_report received (TODO)");
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
  const cmdQuery = pool.query(
    `SELECT id, command_type, payload FROM "NinoGame".commands
      WHERE device_id = $1 AND status = 'pending'
      ORDER BY created_at`,
    [meta.device_id],
  );

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
  await pool.query(
    `INSERT INTO "NinoGame".events (child_id, device_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [meta.child_id, meta.device_id, payload.event_type, payload.payload ?? {}],
  );
}
