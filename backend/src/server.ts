import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
import { signArtifactToken, verifyArtifactToken } from "./services/agent_release.js";
import { initStorage } from "./services/storage/factory.js";
import { pool, ping } from "./db.js";
import { registerAdminAuth, registerParentAuth } from "./auth/middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminAuthRoutes } from "./routes/auth_admin.js";
import { bootstrapAdminIfNeeded } from "./services/admin_bootstrap.js";
import { registerChildrenRoutes } from "./routes/children.js";
import { registerChildSettingsRoutes } from "./routes/child_settings.js";
import { registerCommandRoutes } from "./routes/commands.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerFreePassRoutes } from "./routes/free_pass.js";
import { registerAdminRoutes } from "./routes/admin/index.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerChangelogRoutes } from "./routes/changelog.js";
import { registerRuleRoutes } from "./routes/rules.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerUnlockRequestRoutes } from "./routes/unlock_requests.js";
import {
  startBehaviorBaselineScheduler,
  stopBehaviorBaselineScheduler,
} from "./services/behavior_baseline_scheduler.js";
import {
  startDeviceOfflineAlerter,
  stopDeviceOfflineAlerter,
} from "./services/device_offline_alerter.js";
import {
  startDailySummaryScheduler,
  stopDailySummaryScheduler,
} from "./services/daily_summary_scheduler.js";
import { seedDefaultRulesForChild } from "./services/default_rules.js";
import {
  startWalletSyncScheduler,
  stopWalletSyncScheduler,
} from "./services/wallet_sync_scheduler.js";
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
  await app.register(multipart, {
    limits: {
      // 单文件 ≤ 300MB (够 PyInstaller onedir 130MB + buffer)
      fileSize: 300 * 1024 * 1024,
      files: 1,
    },
  });
  await app.register(websocket);

  // Storage 驱动 (v0.4.0+): factory 按 STORAGE_DRIVER 选 local/s3/aliyun_oss.
  // local 驱动签 token 用; S3 / OSS 自带 presigned URL, 不走 server token.
  initStorage(app.log, (ctx, ttlSeconds) =>
    app.jwt.sign(
      { device_id: ctx.device_id || "", version: ctx.version || "", kind: "artifact" },
      { expiresIn: `${ttlSeconds}s` },
    ),
  );

  // 静态文件 (Agent 升级包, local 驱动): /artifacts/<filename>?token=<jwt>
  // - 路径外挂卷 (Docker volume), 即便镜像重建包也不丢
  // - token 是 server 签发的 30 分钟 jwt, 内含 device_id + version
  // - S3/OSS 驱动下 admin_releases 会改返 presigned URL, /artifacts/* 路由不会被命中
  try {
    fs.mkdirSync(config.artifactsDir, { recursive: true });
  } catch (err) {
    app.log.warn({ err, dir: config.artifactsDir }, "artifacts dir create failed");
  }
  // 鉴权: onRequest hook 在 static plugin 之前跑
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/artifacts/")) return;
    const token = (req.query as { token?: string } | undefined)?.token;
    if (!token) {
      return reply.code(401).send({ message: "missing token" });
    }
    try {
      verifyArtifactToken(app, token);
    } catch (err) {
      app.log.warn({ err }, "artifact token verification failed");
      return reply.code(401).send({ message: "invalid or expired token" });
    }
  });
  await app.register(fastifyStatic, {
    root: path.resolve(config.artifactsDir),
    prefix: "/artifacts/",
    decorateReply: false,
    serve: true,
    index: false,
  });

  // ── 业务路由 ────────────────────────────────────────────
  await registerParentAuth(app);
  await registerAdminAuth(app);
  await registerAuthRoutes(app);
  await registerAdminAuthRoutes(app);
  await registerChildrenRoutes(app);
  await registerChildSettingsRoutes(app);
  await registerDeviceRoutes(app);
  await registerCommandRoutes(app);
  await registerRuleRoutes(app);
  await registerTaskRoutes(app);
  await registerUnlockRequestRoutes(app);
  await registerFreePassRoutes(app);
  await registerReportRoutes(app);
  await registerExportRoutes(app);
  await registerChangelogRoutes(app);
  await registerAdminRoutes(app);
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
      // 关键: 暴露本镜像支持的 WS 消息类型, 让用户排查 "server 没扣" 类问题
      // 时能立刻判断容器是新代码 (有 token_tick) 还是旧代码。
      ws_message_types: [
        "hello", "heartbeat", "event", "usage_report",
        "unlock_request", "task_claim",
        "token_tick",         // 决策 #34 加 (server 单一权威扣分)
        "unknown_apps",       // LLM 应用分类
      ],
    };
  });

  app.get("/", async () => ({
    service: "NinoGame Backend",
    version: "0.4.1",
    docs: "see CLAUDE.md sections 18-19",
    endpoints: [
      "POST /auth/parent/register",
      "POST /auth/parent/login",
      "GET  /auth/parent/me  (Bearer)",
      "POST /auth/admin/login           (v0.4.0+ 管理后台)",
      "GET  /auth/admin/me   (Bearer)",
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
      "POST /api/rules/draft-from-text (Bearer)  LLM 一句话生成规则草稿",
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
      "── /api/admin/* (admin Bearer; 独立管理后台 v0.4.0+) ──",
      "GET/POST/DEL /api/admin/llm                        LLM 配置 (全 server 共享)",
      "POST         /api/admin/llm/test                   LLM 连通性测试",
      "GET/POST/DEL /api/admin/releases[/:id[/promote]]   Agent 升级包管理",
      "GET/POST/DEL /api/admin/app-categories[/:id]       全局应用分类",
      "GET/POST     /api/admin/defaults                   新建 child 默认值 + 默认规则",
      "GET/POST     /api/admin/system                     系统限额 + 存储驱动状态",
      "GET/POST     /api/admin/push                       推送通道配置",
      "GET/POST/DEL /api/admin/tenants[/:id[/reset-password]] 家长账号管理",
      "GET  /artifacts/<filename>?token=<jwt>             Agent 下载升级包 (仅 local 驱动)",
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

  // ── Admin bootstrap (v0.4.0+) ──────────────────────────
  // admin_accounts 空时从环境变量写入首个 admin; 已有就跳过 + 强提醒清环境变量
  await bootstrapAdminIfNeeded(app.log);

  // ── 后台任务 ────────────────────────────────────────────
  // 行为基线异常告警 (§16.1 ④): 每小时扫一次, 异常推家长浏览器 + 企微/邮件
  startBehaviorBaselineScheduler(app.log);
  // 每 60s 主动给所有在线 Agent push 当前 server balance, 兜底 wallet_update
  // 漏 push 的场景 (用户报 "server 在扣但 Agent 显示不动")
  startWalletSyncScheduler(app.log);
  // 设备掉线告警 (v0.4.1+, CLAUDE.md §11.3): 每 2min 扫, last_seen_at >10min 推家长
  startDeviceOfflineAlerter(app.log);
  // 每日总结推送 (v0.4.7+): 每分钟检查本地时间, 命中 admin_settings.daily_summary.time
  // (默认 21:00, opt-in via .enabled) 时给有今日活动的孩子推一条"今日总结"
  startDailySummaryScheduler(app.log);

  app.addHook("onClose", async () => {
    stopBehaviorBaselineScheduler();
    stopWalletSyncScheduler();
    stopDeviceOfflineAlerter();
    stopDailySummaryScheduler();
    await pool.end();
  });

  return app;
}
