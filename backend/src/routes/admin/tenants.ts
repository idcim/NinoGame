/** /api/admin/tenants: 家长账号列表 + 重置密码 + 删除.
 *
 * 当前 1 家庭 = 1 parent, "tenant" 是为未来多租户预留的称呼. v0.4.0 把每个 parent
 * 当作一个 "tenant" 展示给 admin, admin 可以:
 *   - 看全 server 有哪些家长
 *   - 看他们的孩子数 / 设备数 / 最近活跃
 *   - 重置某家长的密码 (家长忘密码场景)
 *   - 删除家长账号 (CASCADE 删孩子 / 设备 / 钱包 — 危险操作!)
 *
 * 不引 tenant 隔离 (用户决定: 重表皮, 仍单家庭), parents.tenant_id 列空着接缝.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db.js";
import { hashPassword } from "../../auth/password.js";

interface TenantRow {
  id: string;
  username: string;
  tenant_id: string | null;
  created_at: string;
  child_count: number;
  device_count: number;
  last_seen: string | null;
}

export async function registerAdminTenantsRoutes(app: FastifyInstance) {
  app.get("/api/admin/tenants", { preHandler: app.adminAuth }, async () => {
    const r = await pool.query<TenantRow>(
      `SELECT p.id, p.username, p.tenant_id, p.created_at,
              (SELECT COUNT(*)::int FROM "NinoGame".children c WHERE c.parent_id = p.id) AS child_count,
              (SELECT COUNT(*)::int FROM "NinoGame".devices d
                  JOIN "NinoGame".device_bindings b ON b.device_id = d.id
                  JOIN "NinoGame".children c ON c.id = b.child_id
                WHERE c.parent_id = p.id) AS device_count,
              (SELECT MAX(last_seen_at)::text FROM "NinoGame".devices d
                  JOIN "NinoGame".device_bindings b ON b.device_id = d.id
                  JOIN "NinoGame".children c ON c.id = b.child_id
                WHERE c.parent_id = p.id) AS last_seen
         FROM "NinoGame".parents p
        ORDER BY p.created_at DESC`,
    );
    return { tenants: r.rows };
  });

  // 重置家长密码 (admin 帮家长改) — bcrypt hash + 强制 ≥ 6 字符
  app.post(
    "/api/admin/tenants/:id/reset-password",
    { preHandler: app.adminAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = z.object({ password: z.string().min(6).max(255) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM "NinoGame".parents WHERE id = $1`,
        [id],
      );
      if (r.rows.length === 0) return reply.notFound("tenant 不存在");
      const hash = await hashPassword(parsed.data.password);
      await pool.query(
        `UPDATE "NinoGame".parents SET password_hash = $1 WHERE id = $2`,
        [hash, id],
      );
      app.log.warn({ admin: req.admin!.sub, tenant: id }, "admin reset tenant password");
      return { ok: true };
    },
  );

  // 删账号 (谨慎; CASCADE 会带走 children / devices / wallets / 全部数据)
  app.delete("/api/admin/tenants/:id", { preHandler: app.adminAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM "NinoGame".parents WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) return reply.notFound("tenant 不存在");
    await pool.query(`DELETE FROM "NinoGame".parents WHERE id = $1`, [id]);
    app.log.warn({ admin: req.admin!.sub, tenant: id }, "admin deleted tenant + cascade");
    return { ok: true };
  });
}
