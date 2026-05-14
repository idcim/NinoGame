/** /auth/admin/login: admin 登录, 签 JWT(kind=admin).
 *
 * 首个 admin 通过环境变量 ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD
 * 在 server.ts 启动时写入 admin_accounts (见 services/admin_bootstrap.ts).
 *
 * 后续 admin 自管 (/api/admin/accounts CRUD) — 但 v0.4.0 仅 1 个 superadmin,
 * UI 不出账号管理页, 改密码可直接改 admin_settings 或 SQL.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { verifyPassword } from "../auth/password.js";

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(255),
});

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
}

export async function registerAdminAuthRoutes(app: FastifyInstance) {
  app.post("/auth/admin/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("请求体格式错误");
    const { username, password } = parsed.data;

    const r = await pool.query<AdminRow>(
      `SELECT id, username, password_hash, display_name, created_at
         FROM "NinoGame".admin_accounts WHERE username = $1`,
      [username],
    );
    const admin = r.rows[0];
    if (!admin) return reply.unauthorized("用户名或密码错误");

    const ok = await verifyPassword(password, admin.password_hash);
    if (!ok) return reply.unauthorized("用户名或密码错误");

    await pool
      .query(
        `UPDATE "NinoGame".admin_accounts SET last_login_at = NOW() WHERE id = $1`,
        [admin.id],
      )
      .catch(() => undefined);

    const token = app.jwt.sign({
      sub: admin.id,
      username: admin.username,
      kind: "admin",
    });
    return {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        display_name: admin.display_name,
        created_at: admin.created_at,
      },
    };
  });

  // 当前登录 admin 详情 (admin UI 显示用户名 / 校验 token 仍有效)
  app.get("/auth/admin/me", { preHandler: app.adminAuth }, async (req) => {
    const r = await pool.query<AdminRow>(
      `SELECT id, username, password_hash, display_name, created_at
         FROM "NinoGame".admin_accounts WHERE id = $1`,
      [req.admin!.sub],
    );
    const admin = r.rows[0];
    if (!admin) {
      return { admin: null };
    }
    return {
      admin: {
        id: admin.id,
        username: admin.username,
        display_name: admin.display_name,
        created_at: admin.created_at,
      },
    };
  });
}
