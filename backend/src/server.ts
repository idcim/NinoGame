import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { pool, ping } from "./db.js";

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

  await app.register(sensible);
  await app.register(cors, { origin: true, credentials: true });

  // ── 健康检查 ─────────────────────────────────────────────
  app.get("/health", async () => {
    const db = await ping();
    return {
      status: "ok",
      env: config.env,
      uptime_seconds: Math.round(process.uptime()),
      db: { time: db.now, version: db.version.split(" ").slice(0, 2).join(" ") },
    };
  });

  // ── 根路径友好提示 ───────────────────────────────────────
  app.get("/", async () => ({
    service: "NinoGame Backend",
    version: "0.1.0",
    docs: "见 CLAUDE.md §18-§19; 接口 P2 实施中",
  }));

  app.addHook("onClose", async () => {
    await pool.end();
  });

  return app;
}
