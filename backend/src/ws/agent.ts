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
import { getActiveFreePass } from "../routes/free_pass.js";
import {
  createTaskClaimFromAgent,
  fetchActiveTasksForChild,
  recordResponsibilityTickFromAgent,
} from "../routes/tasks.js";
import { createUnlockRequestFromAgent } from "../routes/unlock_requests.js";
import { setAgentDecision, clearAgentDecision } from "../services/agent_state.js";
import { getMergedSettings } from "../services/child_settings.js";
import { classifyBatch, type AppToClassify } from "../services/llm_app_classifier.js";
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
  session_id?: string;  // device_online_sessions.id, 关闭时用来 UPDATE
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
        clearAgentDecision(meta.device_id);
        app.log.info({ device_id: meta.device_id }, "/ws/agent disconnected");
        // 关闭在线时段记录
        if (meta.session_id) {
          pool
            .query(
              `UPDATE "NinoGame".device_online_sessions
                  SET disconnected_at = NOW(),
                      duration_seconds = EXTRACT(EPOCH FROM (NOW() - connected_at))::int
                WHERE id = $1`,
              [meta.session_id],
            )
            .catch(() => { /* 关时段写库失败不影响 */ });
        }
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

      // 收尾任何遗留的 open session (前一次没干净关闭)
      void pool.query(
        `UPDATE "NinoGame".device_online_sessions
            SET disconnected_at = NOW(),
                duration_seconds = EXTRACT(EPOCH FROM (NOW() - connected_at))::int
          WHERE device_id = $1 AND disconnected_at IS NULL`,
        [dev.device_id],
      ).catch(() => { /* ignore */ });

      // 打开新的 session
      try {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO "NinoGame".device_online_sessions (device_id, connected_at, remote_ip)
           VALUES ($1, NOW(), $2)
           RETURNING id`,
          [dev.device_id, String(req.ip || "")],
        );
        meta.session_id = r.rows[0].id;
      } catch (err) {
        app.log.warn({ err, device_id: dev.device_id }, "open online session 失败");
      }

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
      await onEvent(app, meta, msg);
      break;
    case "usage_report":
      await onUsageReport(app, meta, msg);
      break;
    case "unlock_request":
      await onUnlockRequest(app, meta, msg);
      break;
    case "task_claim":
      await onTaskClaim(app, meta, msg);
      break;
    case "token_tick":
      await onTokenTick(app, meta, msg);
      break;
    case "unknown_apps":
      await onUnknownApps(app, meta, msg);
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

  // 任务模板: 给 Agent 让它写本地 tasks.json + 重载 checklist
  const tasks = meta.child_id ? await fetchActiveTasksForChild(meta.child_id) : [];

  // 活跃限免 (§14.4): Agent 重启后还能恢复限免态
  const active_free_pass = meta.child_id ? await getActiveFreePass(meta.child_id) : null;

  // settings 上云: Agent 启动 + 重连时拿当前最新设置 (家长可能离线时改过)
  const settings = meta.child_id ? await getMergedSettings(meta.child_id) : null;

  socket.send(
    JSON.stringify({
      type: "hello_ack",
      payload: {
        device_id: meta.device_id,
        child_id: meta.child_id,
        rules: rules.rows,
        tasks,
        wallet_balance: wallet.rows[0]?.balance ?? 0,
        pending_commands: cmds.rows,
        active_free_pass,
        settings,
        server_time: new Date().toISOString(),
      },
    }),
  );
  app.log.info(
    {
      device_id: meta.device_id,
      rules: rules.rows.length,
      tasks: tasks.length,
      cmds: cmds.rows.length,
    },
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

async function onTaskClaim(
  app: FastifyInstance,
  meta: AgentConnection,
  msg: WsMessage,
): Promise<void> {
  const p = (msg.payload || {}) as {
    task_id?: string;
    child_note?: string;
  };
  const task_id = String(p.task_id || "").trim();
  if (!task_id || !meta.child_id) return;
  await createTaskClaimFromAgent(
    app,
    meta.child_id,
    meta.device_id,
    task_id,
    p.child_note,
  );
}

/** Agent token_engine 每 60s tick 推一次 (决策 #34: server 单一权威).
 *  payload: {amount, ref_id, app, tick_seconds}
 *  逻辑: 锁该 child 钱包 → INSERT ledger → UPDATE balance → 推 wallet_update 回。
 *  余额不足时只警告日志, 不扣 (Agent 端在推之前已经做过 cache 检查; 这里是兜底).
 */
async function onTokenTick(
  app: FastifyInstance,
  meta: AgentConnection,
  msg: WsMessage,
): Promise<void> {
  const p = (msg.payload || {}) as {
    amount?: number;
    ref_id?: string;
    app?: string;
    tick_seconds?: number;
  };
  const amount = Math.floor(Math.max(0, Number(p.amount) || 0));
  // 关键诊断: 收到 token_tick 必打日志, 让 docker logs ninogame-backend
  // 能看见 server 端真在处理 (排查 "Agent 推了但 server 没扣" 用)
  app.log.info(
    { device_id: meta.device_id, child_id: meta.child_id, amount, app: p.app },
    "★ 收到 token_tick",
  );
  if (amount <= 0) {
    app.log.warn({ amount, raw: p.amount }, "token_tick amount<=0 跳过");
    return;
  }
  if (!meta.child_id) {
    app.log.warn({ device_id: meta.device_id }, "token_tick: meta.child_id 缺失 (设备没绑孩子?), 跳过");
    return;
  }
  const ref_id = String(p.ref_id || p.app || "").slice(0, 128);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const w = await client.query<{ id: string; balance: number }>(
      `SELECT id, balance FROM "NinoGame".wallets
        WHERE child_id = $1 FOR UPDATE`,
      [meta.child_id],
    );
    if (w.rows.length === 0) {
      await client.query("ROLLBACK");
      app.log.warn({ child_id: meta.child_id }, "onTokenTick: wallet missing");
      return;
    }
    const before = Number(w.rows[0].balance);
    if (before < amount) {
      // server 也兜底拦; Agent 后续 wallet_update 会发现 balance 没变
      await client.query("ROLLBACK");
      app.log.warn(
        { child_id: meta.child_id, before, amount },
        "onTokenTick: server 余额不足, 跳过",
      );
      // 推一次 wallet_update 让 Agent 对齐 (告诉它 server 端余额没动)
      pushToDevice(meta.device_id, {
        type: "wallet_update",
        payload: { balance: before, reason: "server_sync", delta: 0 },
      });
      return;
    }
    const newBalance = before - amount;
    await client.query(
      `INSERT INTO "NinoGame".token_ledger
         (wallet_id, delta, balance_after, reason, ref_id, device_id, occurred_at)
       VALUES ($1, $2, $3, 'app_consumption', $4, $5, NOW())`,
      [w.rows[0].id, -amount, newBalance, ref_id || null, meta.device_id],
    );
    await client.query(
      `UPDATE "NinoGame".wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBalance, w.rows[0].id],
    );
    await client.query("COMMIT");

    // 推 wallet_update 给该 child 所有在线设备
    const devs = await pool.query<{ id: string }>(
      `SELECT d.id FROM "NinoGame".devices d
         JOIN "NinoGame".device_bindings b ON b.device_id = d.id
        WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
      [meta.child_id],
    );
    let pushed = 0;
    for (const d of devs.rows) {
      if (pushToDevice(d.id, {
        type: "wallet_update",
        payload: {
          balance: newBalance,
          reason: "app_consumption",
          delta: -amount,
        },
      })) pushed++;
    }
    app.log.info(
      { child_id: meta.child_id, before, newBalance, amount, pushed },
      "★ token_tick 扣分成功",
    );
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    app.log.warn({ err, child_id: meta.child_id }, "onTokenTick failed");
  } finally {
    client.release();
  }
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

  // 决策 #34: 扣分已经在 token_tick 实时做过, 这里不再据 segments 扣 wallet,
  // 避免双重扣分。usage_report 仅作 app_sessions 历史审计 / 报表数据源。
  app.log.info(
    {
      device_id: meta.device_id,
      child_id: meta.child_id,
      inserted,
      raw: p.segment_count_raw,
      segment_tokens_total: total_tokens_consumed,
    },
    "usage_report processed (history-only, balance unchanged)",
  );
}

async function onHeartbeat(meta: AgentConnection, _msg: WsMessage): Promise<void> {
  await pool.query(
    `UPDATE "NinoGame".devices SET last_seen_at = NOW() WHERE id = $1`,
    [meta.device_id],
  );
}

async function onEvent(app: FastifyInstance, meta: AgentConnection, msg: WsMessage): Promise<void> {
  const payload = msg.payload as { event_type?: string; payload?: unknown };
  if (!payload?.event_type) return;
  const occurred_at = new Date().toISOString();

  // 高频 status / token_decision 不写 events 表 (否则 1440 行/孩子/天),
  // 只更新内存缓存 + publishToParent 让家长浏览器实时面板能拿到。
  const isHighFreqStatus =
    payload.event_type === "status"
    && typeof payload.payload === "object"
    && payload.payload !== null
    && (payload.payload as { kind?: string }).kind === "token_decision";

  if (isHighFreqStatus) {
    const d = payload.payload as {
      kind: "token_decision";
      foreground: string | null;
      category: string | null;
      rate: number;
      mode_active: boolean;
      balance: number;
      deducted: number;
      credited: number;
      skip_reason: string | null;
    };
    setAgentDecision(meta.device_id, d);
    // 仍 publishToParent: 浏览器可订阅实时刷新, 不必每 10s 轮询
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
            event_type: "agent_state",  // 用专门事件名, 不污染 events 流
            payload: d,
            occurred_at,
          });
        }
      } catch {
        /* ignore */
      }
    }
    return;
  }

  await pool.query(
    `INSERT INTO "NinoGame".events (child_id, device_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [meta.child_id, meta.device_id, payload.event_type, payload.payload ?? {}],
  );

  // 责任清单勾选 → upsert responsibility_checks (Agent 不直接调 REST,
  // 走 bus 转发的事件统一通道; 这里在 server 端拆出来落表)
  if (payload.event_type === "checklist_tick" && meta.child_id) {
    const p = (payload.payload || {}) as { task_id?: string; completed?: boolean };
    if (p.task_id) {
      await recordResponsibilityTickFromAgent(
        app,
        meta.child_id,
        String(p.task_id),
        Boolean(p.completed),
      );
    }
  }

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

/** Agent 周期推 unknown_apps WS → 服务端 LLM 分类 → UPSERT server app_categories
 *  → 推回 Agent 写本地缓存 (§9.3 / §12.3 LLM 后台分类器).
 *  失败 (LLM 未配置 / 调用错误) → 单 app 跳过, 下次周期再试.
 */
async function onUnknownApps(
  app: FastifyInstance,
  meta: AgentConnection,
  msg: WsMessage,
): Promise<void> {
  const p = (msg.payload || {}) as { apps?: AppToClassify[] };
  const apps = Array.isArray(p.apps) ? p.apps : [];
  if (apps.length === 0 || !meta.child_id) return;
  // 拿 parent_id (LLM 配置走家长粒度)
  const pq = await pool.query<{ parent_id: string }>(
    `SELECT parent_id FROM "NinoGame".children WHERE id = $1`,
    [meta.child_id],
  );
  const parent_id = pq.rows[0]?.parent_id;
  if (!parent_id) return;

  // 调 LLM batch 分类 (内部并发 5)
  const results = await classifyBatch(parent_id, apps, 5);
  const successful = results.filter((r) => r.result !== null);
  if (successful.length === 0) {
    app.log.info(
      { device_id: meta.device_id, batch: apps.length },
      "onUnknownApps: 全部分类失败 (LLM 未配置/调用错误), 静默",
    );
    return;
  }

  // 写 server 端 app_categories (child_id NULL 表全局; LLM 推断的全局可用)
  // 同时按 child_id 写一份个人 override 也可, 这里先走全局, 简单。
  // 已有 system seed 时只补 display_name, 不覆盖 category (避免 LLM 误判替掉手工预置)
  const updates: Array<{
    app_identifier: string;
    category: string;
    sub_type: string;
    rate_multiplier: number;
    display_name: string | null;
  }> = [];
  for (const r of successful) {
    if (!r.result) continue;
    const rate = 1.0;  // 决策 #33 后 rate_multiplier 不参与扣分; 仅元数据
    const displayName = r.result.display_name || null;
    try {
      await pool.query(
        `INSERT INTO "NinoGame".app_categories
           (app_identifier, category, sub_type, rate_multiplier, classification_source, child_id, display_name)
         VALUES ($1, $2, $3, $4, 'llm', NULL, $5)
         ON CONFLICT (app_identifier) WHERE child_id IS NULL DO UPDATE
           SET display_name = COALESCE("NinoGame".app_categories.display_name, EXCLUDED.display_name)`,
        [r.app_identifier, r.result.category, r.result.sub_type, rate, displayName],
      );
      updates.push({
        app_identifier: r.app_identifier,
        category: r.result.category,
        sub_type: r.result.sub_type,
        rate_multiplier: rate,
        display_name: displayName,
      });
    } catch (err) {
      app.log.warn({ err, app: r.app_identifier }, "app_categories upsert failed");
    }
  }

  if (updates.length === 0) return;

  // 推回 Agent 让它写本地缓存 + 标 processed
  pushToDevice(meta.device_id, {
    type: "app_categories_update",
    payload: { updates },
  });

  app.log.info(
    { device_id: meta.device_id, classified: updates.length, total: apps.length },
    "onUnknownApps processed",
  );
}
