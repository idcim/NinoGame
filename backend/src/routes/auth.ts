import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

const RegisterBody = z.object({
  username: z.string().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(8).max(128),
});

const LoginBody = z.object({
  username: z.string(),
  password: z.string(),
});

interface ParentRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  // ── 注册 ────────────────────────────────────────────────
  app.post("/auth/parent/register", async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { username, password } = parsed.data;

    // 已注册检查
    const dup = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "NinoGame".parents WHERE username = $1',
      [username],
    );
    if (Number(dup.rows[0].count) > 0) {
      return reply.conflict("用户名已被使用");
    }

    const hash = await hashPassword(password);
    const row = await pool.query<ParentRow>(
      `INSERT INTO "NinoGame".parents (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, created_at`,
      [username, hash],
    );
    const parent = row.rows[0];

    const token = app.jwt.sign({ sub: parent.id, username: parent.username });
    return {
      token,
      parent: { id: parent.id, username: parent.username, created_at: parent.created_at },
    };
  });

  // ── 登录 ────────────────────────────────────────────────
  app.post("/auth/parent/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest("请求体格式错误");
    }
    const { username, password } = parsed.data;

    const r = await pool.query<ParentRow>(
      'SELECT id, username, password_hash, created_at FROM "NinoGame".parents WHERE username = $1',
      [username],
    );
    const parent = r.rows[0];
    if (!parent) {
      return reply.unauthorized("用户名或密码错误");
    }
    const ok = await verifyPassword(password, parent.password_hash);
    if (!ok) {
      return reply.unauthorized("用户名或密码错误");
    }
    const token = app.jwt.sign({ sub: parent.id, username: parent.username });
    return {
      token,
      parent: { id: parent.id, username: parent.username, created_at: parent.created_at },
    };
  });

  // ── 当前家长信息 ───────────────────────────────────────
  app.get("/auth/parent/me", { preHandler: app.parentAuth }, async (req) => {
    const r = await pool.query<{
      id: string;
      username: string;
      created_at: string;
      child_count: string;
    }>(
      `SELECT p.id, p.username, p.created_at::text,
              (SELECT COUNT(*)::text FROM "NinoGame".children c WHERE c.parent_id = p.id) AS child_count
         FROM "NinoGame".parents p WHERE p.id = $1`,
      [req.parent!.sub],
    );
    return r.rows[0];
  });
}
