/** Admin 路由组入口 (/api/admin/*).
 *
 * 全部 endpoint 走 app.adminAuth (req.admin 注入 AdminClaim).
 * 子模块按职能分:
 *   - llm.ts        — LLM 配置 (单 admin_settings row, 全 server 共享)
 *   - releases.ts   — Agent 升级包上传 / promote / 删
 *   - app_categories.ts — 全局应用分类 CRUD
 *   - defaults.ts   — 新建 child 默认值 (maturity / quota / 默认规则 seed)
 *   - system.ts     — 系统级限额 + 当前存储驱动状态
 *   - push.ts       — 企微 / SMTP 推送通道配置
 *   - tenants.ts    — 家长账号列表 / 禁用 / 重置密码
 */
import type { FastifyInstance } from "fastify";
import { registerAdminLlmRoutes } from "./llm.js";
import { registerAdminReleaseRoutes } from "./releases.js";
import { registerAdminAppCategoriesRoutes } from "./app_categories.js";
import { registerAdminDefaultsRoutes } from "./defaults.js";
import { registerAdminSystemRoutes } from "./system.js";
import { registerAdminPushRoutes } from "./push.js";
import { registerAdminTenantsRoutes } from "./tenants.js";

export async function registerAdminRoutes(app: FastifyInstance) {
  await registerAdminLlmRoutes(app);
  await registerAdminReleaseRoutes(app);
  await registerAdminAppCategoriesRoutes(app);
  await registerAdminDefaultsRoutes(app);
  await registerAdminSystemRoutes(app);
  await registerAdminPushRoutes(app);
  await registerAdminTenantsRoutes(app);
}
