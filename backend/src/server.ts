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
import { registerRuleRoutes } from "./routes/rules.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerUnlockRequestRoutes } from "./routes/unlock_requests.js";
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
      "WS   /ws/agent?token=<agent_token>",
      "WS   /ws/parent?token=<jwt>",
    ],
  }));

  app.addHook("onClose", async () => {
    await pool.end();
  });

  return app;
}
