import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";

const CreateBody = z.object({
  username: z.string().min(2).max(32).regex(/^[A-Za-z0-9_.-]+$/),
  display_name: z.string().max(64).optional(),
  birth_year: z.number().int().min(2000).max(2030).optional(),
  maturity_mode: z.enum(["strict", "negotiable", "advisory", "self_regulated"]).optional(),
  quota_package: z.enum(["tight", "balanced", "task_driven", "trust", "custom"]).optional(),
});

interface ChildRow {
  id: string;
  parent_id: string;
  username: string;
  display_name: string | null;
  birth_year: number | null;
  maturity_mode: string;
  quota_package: string;
  trust_level: number;
  created_at: string;
}

export async function registerChildrenRoutes(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    // 默认所有 /api/children 都需要家长 token
    if (route.url?.startsWith("/api/children")) {
      // 已通过 preHandler 显式声明
    }
  });

  // ── 创建 ────────────────────────────────────────────────
  app.post("/api/children", { preHandler: app.parentAuth }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const data = parsed.data;

    const dup = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "NinoGame".children WHERE username = $1',
      [data.username],
    );
    if (Number(dup.rows[0].count) > 0) {
      return reply.conflict("孩子用户名已被使用");
    }

    const r = await pool.query<ChildRow>(
      `INSERT INTO "NinoGame".children
        (parent_id, username, display_name, birth_year, maturity_mode, quota_package)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'negotiable'), COALESCE($6, 'balanced'))
       RETURNING id, parent_id, username, display_name, birth_year,
                 maturity_mode, quota_package, trust_level, created_at`,
      [
        req.parent!.sub,
        data.username,
        data.display_name ?? null,
        data.birth_year ?? null,
        data.maturity_mode ?? null,
        data.quota_package ?? null,
      ],
    );
    // 给孩子开一个钱包
    await pool.query(
      'INSERT INTO "NinoGame".wallets (child_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [r.rows[0].id],
    );
    return r.rows[0];
  });

  // ── 列出当前家长的孩子 ────────────────────────────────
  app.get("/api/children", { preHandler: app.parentAuth }, async (req) => {
    const r = await pool.query<ChildRow & { balance: number }>(
      `SELECT c.id, c.parent_id, c.username, c.display_name, c.birth_year,
              c.maturity_mode, c.quota_package, c.trust_level, c.created_at,
              COALESCE(w.balance, 0)::int AS balance
         FROM "NinoGame".children c
         LEFT JOIN "NinoGame".wallets w ON w.child_id = c.id
        WHERE c.parent_id = $1
        ORDER BY c.created_at`,
      [req.parent!.sub],
    );
    return { children: r.rows };
  });
}
