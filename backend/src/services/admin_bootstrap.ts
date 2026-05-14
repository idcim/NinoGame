/** 首个 admin 账号 bootstrap (v0.4.0+).
 *
 * server 启动时检查:
 *   admin_accounts 空 + ADMIN_BOOTSTRAP_USERNAME 有值 → 创建一行 (bcrypt hash password).
 *
 * 创建成功后强提醒清除环境变量 — 否则每次重启都会日志说 "bootstrap skipped (已有 admin)",
 * 但密码留环境变量历史里不安全.
 */
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { pool } from "../db.js";
import { hashPassword } from "../auth/password.js";

export async function bootstrapAdminIfNeeded(logger: FastifyBaseLogger): Promise<void> {
  const username = (config.adminBootstrap.username || "").trim();
  const password = (config.adminBootstrap.password || "").trim();

  // 没设环境变量 → 跳过
  if (!username && !password) {
    logger.debug("admin bootstrap: 环境变量未设, 跳过");
    return;
  }
  if (!username || !password) {
    logger.warn(
      "admin bootstrap: ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD 必须同时设置",
    );
    return;
  }
  if (password.length < 6) {
    logger.warn("admin bootstrap: 密码 < 6 字符, 拒绝创建");
    return;
  }

  try {
    const exists = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "NinoGame".admin_accounts`,
    );
    if (Number(exists.rows[0].count) > 0) {
      logger.info(
        "admin bootstrap: admin_accounts 已有数据, 跳过. " +
          "**请删除环境变量 ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD 避免泄漏**",
      );
      return;
    }

    const hash = await hashPassword(password);
    await pool.query(
      `INSERT INTO "NinoGame".admin_accounts (username, password_hash, display_name)
       VALUES ($1, $2, 'Bootstrap Admin')`,
      [username, hash],
    );
    logger.info(
      { username },
      "admin bootstrap: 已创建首个 admin. **请立刻登录 admin 后台改密码, 然后从环境变量删除 ADMIN_BOOTSTRAP_PASSWORD**",
    );
  } catch (err) {
    logger.error({ err }, "admin bootstrap failed");
  }
}
