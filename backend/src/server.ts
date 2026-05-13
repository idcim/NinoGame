import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { pool, ping } from "./db.js";
import { registerParentAuth } from "./auth/middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChildrenRoutes } from "./routes/children.js";
import { registerCommandRoutes } from "./routes/commands.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerFreePassRoutes } from "./routes/free_pass.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerRuleRoutes } from "./routes/rules.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerUnlockRequestRoutes } from "./routes/unlock_requests.js";
import {
  startBehaviorBaselineScheduler,
  stopBehaviorBaselineScheduler,
} from "./services/behavior_baseline_scheduler.js";
import { seedDefaultRulesForChild } from "./services/default_rules.js";
import { registerAgentWebSocket, getConnectedDevices } from "./ws/agent.js";
import { registerParentWebSocket } from "./ws/parent.js";

export async function buildServer() {
  const app = Fastify({
    logger: config.logPretty
      ? {
          level: config.logLevel,
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss" },
          },
        }
      : { level: config.logLevel },
    trustProxy: true,
  });

  // ── 插件 ─────────────────────────────────────────────────
  await app.register(sensible);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  });
  await app.register(websocket);

  // ── 业务路由 ────────────────────────────────────────────
  await registerParentAuth(app);
  await registerAuthRoutes(app);
  await registerChildrenRoutes(app);
  await registerDeviceRoutes(app);
  await registerCommandRoutes(app);
  await registerRuleRoutes(app);
  await registerTaskRoutes(app);
  await registerUnlockRequestRoutes(app);
  await registerFreePassRoutes(app);
  await registerReportRoutes(app);
  await registerAgentWebSocket(app);
  await registerParentWebSocket(app);

  // ── 基础 ────────────────────────────────────────────────
  app.get("/health", async () => {
    const db = await ping();
    return {
      status: "ok",
      env: config.env,
      uptime_seconds: Math.round(process.uptime()),
      db: { time: db.now, version: db.version.split(" ").slice(0, 2).join(" ") },
      agents_connected: getConnectedDevices().length,
    };
  });

  app.get("/", async () => ({
    service: "NinoGame Backend",
    version: "0.1.0",
    docs: "see CLAUDE.md sections 18-19",
    endpoints: [
      "POST /auth/parent/register",
      "POST /auth/parent/login",
      "GET  /auth/parent/me  (Bearer)",
      "POST /api/children    (Bearer)",
      "GET  /api/children    (Bearer)",
      "POST /api/devices/pair        (Bearer)",
      "POST /api/devices/pair/redeem",
      "GET  /api/devices             (Bearer)",
      "POST /api/devices/:id/regenerate-pair  (Bearer)",
      "DEL  /api/devices/:id         (Bearer)",
      "POST /api/children/:id/wallet/adjust   (Bearer)",
      "GET  /api/unlock-requests?status        (Bearer)",
      "POST /api/unlock-requests/:id/approve   (Bearer)",
      "POST /api/unlock-requests/:id/reject    (Bearer)",
      "POST /api/commands            (Bearer)",
      "GET  /api/commands?device_id  (Bearer)",
      "GET  /api/rules?child_id      (Bearer)",
      "POST /api/rules               (Bearer)",
      "PUT  /api/rules/:id           (Bearer)",
      "DEL  /api/rules/:id           (Bearer)",
      "GET  /api/tasks?child_id      (Bearer)",
      "POST /api/tasks               (Bearer)",
      "PUT  /api/tasks/:id           (Bearer)",
      "DEL  /api/tasks/:id           (Bearer)",
      "GET  /api/task-completions?status     (Bearer)",
      "POST /api/task-completions/:id/approve (Bearer)",
      "POST /api/task-completions/:id/reject  (Bearer)",
      "GET  /api/responsibility-checks?child_id&days (Bearer)",
      "POST /api/free-pass           (Bearer)",
      "POST /api/free-pass/:id/end   (Bearer)",
      "GET  /api/free-pass/active?child_id (Bearer)",
      "GET  /api/free-pass?child_id  (Bearer)",
      "GET  /api/children/:id/reports/daily?days     (Bearer)",
      "GET  /api/children/:id/reports/top-apps?days&limit (Bearer)",
      "WS   /ws/agent?token=<agent_token>",
      "WS   /ws/parent?token=<jwt>",
    ],
  }));

  // ── 一次性 schema 迁移 (老 photo 验证方式 → parent_approve) ──
  // 拍照证据机制已下线 (改用私下协商 + 家长后台手动 +token), 顺手把
  // 历史任务模板里的 verification='photo' 迁回 parent_approve, 避免前端
  // 渲染未知 enum。task_completions.photo_url 列暂保留容纳历史数据。
  try {
    const r = await pool.query(
      `UPDATE "NinoGame".task_templates
          SET verification = 'parent_approve'
        WHERE verification = 'photo'`,
    );
    if (r.rowCount && r.rowCount > 0) {
      app.log.info({ migrated: r.rowCount }, "photo verification → parent_approve");
    }
  } catch (err) {
    app.log.warn({ err }, "photo verification migration failed (table may not exist yet)");
  }

  // ── 给老孩子补默认 PvZ 规则 (一次性) ──────────────────
  // 新建孩子已经在 children.ts 事务里 seed; 这里照顾"升级前已存在
  // 但还没有任何规则" 的孩子, 让"申请批准放行所有规则" 链路有东西可放行。
  try {
    const orphans = await pool.query<{ id: string }>(
      `SELECT c.id FROM "NinoGame".children c
        WHERE NOT EXISTS (
          SELECT 1 FROM "NinoGame".rules r WHERE r.child_id = c.id
        )`,
    );
    if (orphans.rows.length > 0) {
      const client = await pool.connect();
      try {
        for (const row of orphans.rows) {
          await seedDefaultRulesForChild(client, row.id, app.log);
        }
      } finally {
        client.release();
      }
      app.log.info({ count: orphans.rows.length }, "seeded default PvZ rule for orphan children");
    }
  } catch (err) {
    app.log.warn({ err }, "seed orphan children failed");
  }

  // ── 后台任务 ────────────────────────────────────────────
  // 行为基线异常告警 (§16.1 ④): 每小时扫一次, 异常推家长浏览器
  startBehaviorBaselineScheduler(app.log);

  app.addHook("onClose", async () => {
    stopBehaviorBaselineScheduler();
    await pool.end();
  });

  return app;
}
