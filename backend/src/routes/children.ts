import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { pushToDevice } from "../ws/agent.js";
import { publishToParent } from "../ws/event_bus.js";

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

  // ── 钱包调账 (家长酌赠 / 扣除) ────────────────────────
  app.post(
    "/api/children/:id/wallet/adjust",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const AdjustBody = z.object({
        delta: z.number().int().min(-500).max(500),
        reason: z.enum(["parent_grant", "adjustment", "task_reward"]).default("parent_grant"),
        comment: z.string().max(256).optional(),
      });
      const parsed = AdjustBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { delta, reason, comment } = parsed.data;
      if (delta === 0) {
        return reply.badRequest("delta 不能为 0");
      }
      // 验证归属
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "NinoGame".children
          WHERE id = $1 AND parent_id = $2`,
        [child_id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }

      // 事务: 锁 wallet + INSERT ledger + UPDATE balance
      const client = await pool.connect();
      let newBalance = 0;
      try {
        await client.query("BEGIN");
        const w = await client.query<{ id: string; balance: number }>(
          `SELECT id, balance FROM "NinoGame".wallets
            WHERE child_id = $1 FOR UPDATE`,
          [child_id],
        );
        if (w.rows.length === 0) {
          await client.query("ROLLBACK");
          return reply.notFound("钱包不存在");
        }
        const before = Number(w.rows[0].balance);
        newBalance = Math.max(0, before + delta);
        const realDelta = newBalance - before;
        await client.query(
          `INSERT INTO "NinoGame".token_ledger
             (wallet_id, delta, balance_after, reason, occurred_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [w.rows[0].id, realDelta, newBalance, reason],
        );
        await client.query(
          `UPDATE "NinoGame".wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
          [newBalance, w.rows[0].id],
        );
        await client.query("COMMIT");
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }

      // 推 wallet_update 给该孩子所有在线 Agent (本地缓存同步)
      const devs = await pool.query<{ id: string }>(
        `SELECT d.id FROM "NinoGame".devices d
           JOIN "NinoGame".device_bindings b ON b.device_id = d.id
          WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
        [child_id],
      );
      let pushed = 0;
      for (const d of devs.rows) {
        if (
          pushToDevice(d.id, {
            type: "wallet_update",
            payload: { balance: newBalance, reason, delta, comment },
          })
        ) pushed++;
      }
      // 推家长浏览器 event_bus 让 EventFeed 也看到
      publishToParent({
        parent_id: req.parent!.sub,
        child_id,
        device_id: null,
        event_type: delta > 0 ? "token_credit" : "token_deduct",
        payload: { amount: Math.abs(delta), reason, comment, new_balance: newBalance },
        occurred_at: new Date().toISOString(),
      });

      app.log.info(
        { child_id, delta, reason, balance: newBalance, pushed },
        "wallet adjust",
      );
      return { balance: newBalance, delta, pushed };
    },
  );

  // ── ledger 历史 (查最近 N 条 token 变动) ──────────────
  app.get(
    "/api/children/:id/ledger",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string>;
      const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
      // 验证归属
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "NinoGame".children
          WHERE id = $1 AND parent_id = $2`,
        [child_id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const r = await pool.query<{
        id: string;
        delta: number;
        balance_after: number;
        reason: string;
        occurred_at: string;
      }>(
        `SELECT l.id, l.delta, l.balance_after, l.reason, l.occurred_at
           FROM "NinoGame".token_ledger l
           JOIN "NinoGame".wallets w ON w.id = l.wallet_id
          WHERE w.child_id = $1
          ORDER BY l.occurred_at DESC
          LIMIT $2`,
        [child_id, limit],
      );
      return { entries: r.rows };
    },
  );

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
