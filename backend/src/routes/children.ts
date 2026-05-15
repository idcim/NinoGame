import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { seedDefaultRulesForChild } from "../services/default_rules.js";
import { pushToDevice } from "../ws/agent.js";
import { publishToParent } from "../ws/event_bus.js";
import { hashNewPin } from "../services/parent_pin.js";

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

    // 事务: child + wallet + default rule 一起做, 任何一步失败回滚
    const client = await pool.connect();
    let child: ChildRow;
    try {
      await client.query("BEGIN");
      const r = await client.query<ChildRow>(
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
      child = r.rows[0];
      // 钱包
      await client.query(
        'INSERT INTO "NinoGame".wallets (child_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [child.id],
      );
      // 默认规则 (PvZ 全家桶), 家长开箱就有, 不用再去 /rules 手动建
      await seedDefaultRulesForChild(client, child.id, app.log);
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
    return child;
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

  // ── 全局 pending 计数 (任何页面都能看到红点 badge) ────
  app.get(
    "/api/pending-counts",
    { preHandler: app.parentAuth },
    async (req) => {
      const parent_id = req.parent!.sub;
      // task_completions pending: 该家长所有孩子的待审批任务
      const t = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "NinoGame".task_completions tc
           JOIN "NinoGame".children c ON c.id = tc.child_id
          WHERE c.parent_id = $1 AND tc.status = 'pending'`,
        [parent_id],
      );
      const r = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "NinoGame".unlock_requests ur
           JOIN "NinoGame".children c ON c.id = ur.child_id
          WHERE c.parent_id = $1 AND ur.status = 'pending'`,
        [parent_id],
      );
      return {
        pending_tasks: Number(t.rows[0].count),
        pending_requests: Number(r.rows[0].count),
      };
    },
  );

  // ── ledger 历史 (查最近 N 条 token 变动) ──────────────
  // 默认隐藏 app_consumption (每分钟 1 条噪音 = 1440/天), 仅展示家长操作
  // (parent_grant / task_reward / adjustment / daily_grant 等).
  // ?include_consumption=true 切换看完整明细。
  app.get(
    "/api/children/:id/ledger",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string>;
      const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
      const includeConsumption = q.include_consumption === "true";
      // 验证归属
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "NinoGame".children
          WHERE id = $1 AND parent_id = $2`,
        [child_id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const filterSql = includeConsumption
        ? ""
        : "AND l.reason <> 'app_consumption'";
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
          WHERE w.child_id = $1 ${filterSql}
          ORDER BY l.occurred_at DESC
          LIMIT $2`,
        [child_id, limit],
      );
      return { entries: r.rows };
    },
  );

  // ── 列出当前家长的孩子 ────────────────────────────────
  // 同时附 maturity_suggestion (若有): 最近 30 天内 emit 过 maturity_upgrade_suggestion,
  // 且 target 与当前 maturity_mode 不同, 且未被家长 dismiss 过.
  app.get("/api/children", { preHandler: app.parentAuth }, async (req) => {
    const r = await pool.query<
      ChildRow & {
        balance: number;
        dismissed_maturity_target: string | null;
        suggestion_to: string | null;
        suggestion_from: string | null;
        suggestion_trust_level: number | null;
        suggestion_at: string | null;
      }
    >(
      `SELECT c.id, c.parent_id, c.username, c.display_name, c.birth_year,
              c.maturity_mode, c.quota_package, c.trust_level, c.created_at,
              COALESCE(w.balance, 0)::int AS balance,
              c.dismissed_maturity_target,
              s.to_mode AS suggestion_to,
              s.from_mode AS suggestion_from,
              s.trust_level AS suggestion_trust_level,
              s.occurred_at AS suggestion_at
         FROM "NinoGame".children c
         LEFT JOIN "NinoGame".wallets w ON w.child_id = c.id
         LEFT JOIN LATERAL (
           SELECT payload->>'to' AS to_mode,
                  payload->>'from' AS from_mode,
                  (payload->>'trust_level')::int AS trust_level,
                  occurred_at::text AS occurred_at
             FROM "NinoGame".events
            WHERE child_id = c.id
              AND event_type = 'maturity_upgrade_suggestion'
              AND occurred_at > NOW() - INTERVAL '30 days'
            ORDER BY occurred_at DESC
            LIMIT 1
         ) s ON TRUE
        WHERE c.parent_id = $1
        ORDER BY c.created_at`,
      [req.parent!.sub],
    );
    const children = r.rows.map((row) => {
      const live =
        row.suggestion_to &&
        row.suggestion_to !== row.maturity_mode &&
        row.suggestion_to !== row.dismissed_maturity_target;
      const {
        suggestion_to,
        suggestion_from,
        suggestion_trust_level,
        suggestion_at,
        dismissed_maturity_target: _dmt,
        ...base
      } = row;
      return {
        ...base,
        maturity_suggestion: live
          ? {
              from: suggestion_from!,
              to: suggestion_to!,
              trust_level: suggestion_trust_level ?? 0,
              suggested_at: suggestion_at!,
            }
          : null,
      };
    });
    return { children };
  });

  // ── 改 maturity_mode (一键应用建议 / 家长手动调档) ────
  app.patch(
    "/api/children/:id",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const PatchBody = z.object({
        maturity_mode: z
          .enum(["strict", "negotiable", "advisory", "self_regulated"])
          .optional(),
      });
      const parsed = PatchBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { maturity_mode } = parsed.data;
      if (!maturity_mode) {
        return reply.badRequest("没有字段可更新");
      }
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "NinoGame".children
          WHERE id = $1 AND parent_id = $2`,
        [child_id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const upd = await pool.query<{ maturity_mode: string }>(
        `UPDATE "NinoGame".children
            SET maturity_mode = $2,
                dismissed_maturity_target = NULL
          WHERE id = $1
        RETURNING maturity_mode`,
        [child_id, maturity_mode],
      );
      app.log.info(
        { child_id, maturity_mode },
        "child maturity_mode updated",
      );
      return { maturity_mode: upd.rows[0].maturity_mode };
    },
  );

  // ── 暂不升级 (dismiss 当前 suggestion) ───────────────
  app.post(
    "/api/children/:id/maturity-suggestion/dismiss",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      // 验证归属 + 拉当前建议 target
      const r = await pool.query<{ to_mode: string | null }>(
        `SELECT (e.payload->>'to') AS to_mode
           FROM "NinoGame".children c
           LEFT JOIN LATERAL (
             SELECT payload FROM "NinoGame".events
              WHERE child_id = c.id
                AND event_type = 'maturity_upgrade_suggestion'
                AND occurred_at > NOW() - INTERVAL '30 days'
              ORDER BY occurred_at DESC
              LIMIT 1
           ) e ON TRUE
          WHERE c.id = $1 AND c.parent_id = $2`,
        [child_id, req.parent!.sub],
      );
      if (r.rows.length === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const target = r.rows[0].to_mode;
      if (!target) {
        return reply.notFound("当前没有未处理的升级建议");
      }
      await pool.query(
        `UPDATE "NinoGame".children
            SET dismissed_maturity_target = $2
          WHERE id = $1`,
        [child_id, target],
      );
      app.log.info({ child_id, dismissed_target: target }, "maturity suggestion dismissed");
      return { dismissed: target };
    },
  );

  // ── v0.4.3+ 家长 PIN 主从同步 ────────────────────────
  //
  // PIN 设计 (CLAUDE.md §3.2): 跟 child 绑定, 多设备共享. server 持 PBKDF2
  // hash + salt, 设/改时立刻推 pin_sync 给所有该 child 在线设备. 配对完成
  // / Agent 重启时通过 hello_ack 自动同步, 不需要家长手动给每台设备点"设 PIN".

  const SetPinBody = z.object({
    pin: z.string().min(4).max(12).regex(/^\d+$/, "PIN 只接受 4-12 位数字"),
  });

  app.post(
    "/api/children/:id/parent-pin",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "NinoGame".children
          WHERE id = $1 AND parent_id = $2`,
        [child_id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const parsed = SetPinBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { hash_hex, salt_hex } = hashNewPin(parsed.data.pin);
      await pool.query(
        `UPDATE "NinoGame".children
            SET parent_pin_hash = $1, parent_pin_salt = $2
          WHERE id = $3`,
        [hash_hex, salt_hex, child_id],
      );

      // 推 pin_sync 给该 child 所有在线设备
      const devs = await pool.query<{ id: string }>(
        `SELECT d.id FROM "NinoGame".devices d
          JOIN "NinoGame".device_bindings b ON b.device_id = d.id
         WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
        [child_id],
      );
      let pushed = 0;
      for (const d of devs.rows) {
        if (pushToDevice(d.id, {
          type: "pin_sync",
          payload: { hash_hex, salt_hex },
        })) pushed++;
      }
      app.log.info({ child_id, devices: devs.rows.length, pushed }, "★ parent PIN set + sync");
      return { ok: true, devices: devs.rows.length, pushed };
    },
  );

  app.delete(
    "/api/children/:id/parent-pin",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const child_id = (req.params as { id: string }).id;
      const own = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "NinoGame".children
          WHERE id = $1 AND parent_id = $2`,
        [child_id, req.parent!.sub],
      );
      if (Number(own.rows[0].count) === 0) {
        return reply.forbidden("孩子不属于当前家长");
      }
      await pool.query(
        `UPDATE "NinoGame".children
            SET parent_pin_hash = NULL, parent_pin_salt = NULL
          WHERE id = $1`,
        [child_id],
      );
      const devs = await pool.query<{ id: string }>(
        `SELECT d.id FROM "NinoGame".devices d
          JOIN "NinoGame".device_bindings b ON b.device_id = d.id
         WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
        [child_id],
      );
      let pushed = 0;
      for (const d of devs.rows) {
        if (pushToDevice(d.id, {
          type: "pin_clear",
          payload: {},
        })) pushed++;
      }
      app.log.info({ child_id, devices: devs.rows.length, pushed }, "★ parent PIN cleared + sync");
      return { ok: true, devices: devs.rows.length, pushed };
    },
  );
}
