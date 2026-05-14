/** /api/admin/app-categories: 全局应用分类 CRUD (child_id IS NULL 那批).
 *
 * 用途:
 *   - 看 LLM 自动分类入库的进程, 修正分类 / 改 display_name
 *   - 手动新增 admin 认知里有的应用 (避免等 LLM)
 *   - 删错分类
 *
 * 仅操作 child_id IS NULL 的 "全局" 行; per-child override 保持原有家长可改流程.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db.js";

const Body = z.object({
  app_identifier: z.string().min(1).max(255),
  category: z.enum(["consumption", "productive", "neutral"]),
  sub_type: z.string().min(1).max(32).default("unknown"),
  display_name: z.string().min(1).max(128).optional().nullable(),
  rate_multiplier: z.number().min(0).max(10).default(1.0),
});

interface Row {
  id: string;
  app_identifier: string;
  category: string;
  sub_type: string | null;
  display_name: string | null;
  rate_multiplier: number;
  classification_source: string;
  created_at: string;
}

export async function registerAdminAppCategoriesRoutes(app: FastifyInstance) {
  app.get("/api/admin/app-categories", { preHandler: app.adminAuth }, async (req) => {
    const q = (req.query ?? {}) as { source?: string; limit?: string };
    const limit = Math.max(10, Math.min(500, Number(q.limit) || 200));
    // 可选按 classification_source 过滤 (system seed / llm / admin / parent)
    if (q.source) {
      const r = await pool.query<Row>(
        `SELECT id, app_identifier, category, sub_type, display_name,
                rate_multiplier::float AS rate_multiplier,
                classification_source, created_at
           FROM "NinoGame".app_categories
          WHERE child_id IS NULL AND classification_source = $1
          ORDER BY app_identifier
          LIMIT $2`,
        [q.source, limit],
      );
      return { categories: r.rows };
    }
    const r = await pool.query<Row>(
      `SELECT id, app_identifier, category, sub_type, display_name,
              rate_multiplier::float AS rate_multiplier,
              classification_source, created_at
         FROM "NinoGame".app_categories
        WHERE child_id IS NULL
        ORDER BY app_identifier
        LIMIT $1`,
      [limit],
    );
    return { categories: r.rows };
  });

  // upsert (按 app_identifier + child_id=NULL): admin 修改的 source 改 'admin'
  app.post("/api/admin/app-categories", { preHandler: app.adminAuth }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const v = parsed.data;
    const r = await pool.query<Row>(
      `INSERT INTO "NinoGame".app_categories
         (app_identifier, category, sub_type, rate_multiplier, classification_source, child_id, display_name)
       VALUES ($1, $2, $3, $4, 'admin', NULL, $5)
       ON CONFLICT (app_identifier) WHERE child_id IS NULL DO UPDATE
         SET category = EXCLUDED.category,
             sub_type = EXCLUDED.sub_type,
             rate_multiplier = EXCLUDED.rate_multiplier,
             display_name = EXCLUDED.display_name,
             classification_source = 'admin'
       RETURNING id, app_identifier, category, sub_type, display_name,
                 rate_multiplier::float AS rate_multiplier, classification_source, created_at`,
      [
        v.app_identifier.toLowerCase(),
        v.category,
        v.sub_type,
        v.rate_multiplier,
        v.display_name ?? null,
      ],
    );
    return { category: r.rows[0] };
  });

  app.delete("/api/admin/app-categories/:id", { preHandler: app.adminAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await pool.query<{ classification_source: string }>(
      `DELETE FROM "NinoGame".app_categories
        WHERE id = $1 AND child_id IS NULL
        RETURNING classification_source`,
      [id],
    );
    if (r.rows.length === 0) return reply.notFound("分类不存在或不是全局行");
    return { ok: true };
  });
}
