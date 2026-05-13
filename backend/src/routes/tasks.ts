/** /api/tasks: 任务模板 CRUD + 任务完成审批流程 (CLAUDE.md §8.3 / §8.6)。
 *
 * 表:
 *   - task_templates: 家长定义的模板 (责任/激励)
 *   - task_completions: 孩子申报 → 家长审批 → 写 ledger
 *   - responsibility_checks: 责任清单每日勾选 (不挣分, 走 Agent bus 直推)
 *
 * Agent 流:
 *   - hello_ack.tasks: 服务端推所有 active 模板; Agent 写 tasks.json + 重载 checklist
 *   - tasks_update: 模板增删改后, 全量推一遍
 *   - WS in: {type:"task_claim", payload:{task_id, child_note}} 激励类申报
 *   - WS in: {type:"event", payload:{event_type:"checklist_tick", payload:{task_id, completed}}}
 *     → onEvent 检测到 event_type=checklist_tick 时 upsert responsibility_checks
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { pushToDevice } from "../ws/agent.js";
import { publishToParent } from "../ws/event_bus.js";

// ── schema ─────────────────────────────────────────────────────
const CreateTaskBody = z.object({
  child_id: z.string().uuid(),
  name: z.string().min(1).max(128),
  category: z.enum(["responsibility", "incentive"]).default("incentive"),
  reward_tokens: z.number().int().min(0).max(500).default(0),
  daily_max_completions: z.number().int().min(1).max(10).default(1),
  verification: z.enum(["parent_approve", "self_report", "auto"]).default("parent_approve"),
  schedule: z.enum(["daily", "weekly", "once"]).default("daily"),
  active: z.boolean().default(true),
});

const UpdateTaskBody = z.object({
  name: z.string().min(1).max(128).optional(),
  category: z.enum(["responsibility", "incentive"]).optional(),
  reward_tokens: z.number().int().min(0).max(500).optional(),
  daily_max_completions: z.number().int().min(1).max(10).optional(),
  verification: z.enum(["parent_approve", "self_report", "auto"]).optional(),
  schedule: z.enum(["daily", "weekly", "once"]).optional(),
  active: z.boolean().optional(),
});

const ApproveBody = z.object({
  reward_override: z.number().int().min(0).max(500).optional(),
  comment: z.string().max(512).optional(),
});

const RejectBody = z.object({
  comment: z.string().max(512).optional(),
});

interface TaskRow {
  id: string;
  child_id: string;
  name: string;
  category: string;
  reward_tokens: number;
  daily_max_completions: number;
  verification: string;
  schedule: string;
  active: boolean;
}

interface CompletionRow {
  id: string;
  task_id: string;
  child_id: string;
  status: string;
  photo_url: string | null;
  child_note: string | null;
  llm_summary: string | null;
  parent_decision_at: string | null;
  parent_comment: string | null;
  reward_granted: number | null;
  created_at: string;
}

// ── helpers ────────────────────────────────────────────────────
async function ensureChildOwnership(parent_id: string, child_id: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "NinoGame".children WHERE id = $1 AND parent_id = $2`,
    [child_id, parent_id],
  );
  return Number(r.rows[0].count) > 0;
}

/** 推所有 active 任务给该孩子所有在线设备。返回成功推送的设备数。 */
export async function pushTasksUpdate(child_id: string): Promise<number> {
  const tasks = await pool.query<TaskRow>(
    `SELECT id, child_id, name, category, reward_tokens, daily_max_completions,
            verification, schedule, active
       FROM "NinoGame".task_templates
      WHERE child_id = $1 AND active = TRUE
      ORDER BY category, name`,
    [child_id],
  );
  const devices = await pool.query<{ id: string }>(
    `SELECT d.id FROM "NinoGame".devices d
       JOIN "NinoGame".device_bindings b ON b.device_id = d.id
      WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
    [child_id],
  );
  let pushed = 0;
  for (const d of devices.rows) {
    if (
      pushToDevice(d.id, {
        type: "tasks_update",
        payload: { tasks: tasks.rows },
      })
    ) pushed++;
  }
  return pushed;
}

/** 从 hello_ack 调; 返回该孩子所有 active 模板, 供 Agent 写本地 tasks.json。 */
export async function fetchActiveTasksForChild(child_id: string): Promise<TaskRow[]> {
  const r = await pool.query<TaskRow>(
    `SELECT id, child_id, name, category, reward_tokens, daily_max_completions,
            verification, schedule, active
       FROM "NinoGame".task_templates
      WHERE child_id = $1 AND active = TRUE
      ORDER BY category, name`,
    [child_id],
  );
  return r.rows;
}

/** Agent WS 上来的 task_claim. 写 task_completions(status=pending) + 推家长 bus。 */
export async function createTaskClaimFromAgent(
  app: FastifyInstance,
  child_id: string,
  device_id: string,
  task_id: string,
  child_note?: string,
): Promise<CompletionRow | null> {
  if (!child_id || !task_id) return null;
  try {
    // 验证 task 属于该孩子 + 还 active
    const t = await pool.query<TaskRow>(
      `SELECT id, child_id, name, category, reward_tokens, daily_max_completions,
              verification, schedule, active
         FROM "NinoGame".task_templates
        WHERE id = $1 AND child_id = $2`,
      [task_id, child_id],
    );
    if (t.rows.length === 0) {
      app.log.warn({ child_id, task_id }, "task_claim: 任务不存在或不归该孩子");
      return null;
    }
    const task = t.rows[0];
    if (!task.active) {
      app.log.warn({ child_id, task_id }, "task_claim: 任务已禁用");
      return null;
    }
    if (task.category === "responsibility") {
      app.log.info({ child_id, task_id }, "task_claim: 责任类任务不走审批, 改走 checklist_tick");
      return null;
    }

    // 申报: status=pending; verification=self_report/auto 也先入 pending, 家长能看见。
    // 后续 P3 可以让 self_report/auto 直接自动批准。
    const r = await pool.query<CompletionRow>(
      `INSERT INTO "NinoGame".task_completions
         (task_id, child_id, status, child_note)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id, task_id, child_id, status, photo_url, child_note,
                 llm_summary, parent_decision_at, parent_comment,
                 reward_granted, created_at`,
      [task_id, child_id, child_note ?? null],
    );
    const row = r.rows[0];

    // 推家长浏览器 (实时事件流)
    const pq = await pool.query<{ parent_id: string }>(
      `SELECT parent_id FROM "NinoGame".children WHERE id = $1`,
      [child_id],
    );
    const parent_id = pq.rows[0]?.parent_id;
    if (parent_id) {
      publishToParent({
        parent_id,
        child_id,
        device_id,
        event_type: "task_claim",
        payload: {
          completion_id: row.id,
          task_id,
          task_name: task.name,
          reward_tokens: task.reward_tokens,
          child_note: child_note || null,
        },
        occurred_at: row.created_at,
      });
    }
    app.log.info(
      { child_id, task_id, completion_id: row.id, task: task.name },
      "task_claim received",
    );
    return row;
  } catch (err) {
    app.log.warn({ err, child_id, task_id }, "create task_claim failed");
    return null;
  }
}

/** Agent bus event "checklist_tick" → upsert responsibility_checks。
 *  约定 payload: {task_id, completed} (checklist.py 已经发这个结构)。
 *  task_id 必须是 task_templates.id (UUID); 老 Agent 的 "task_clean_desk" 这种
 *  字符串 id 会被跳过 (P2 任务全走 server 同步, 不会出现)。
 */
export async function recordResponsibilityTickFromAgent(
  app: FastifyInstance,
  child_id: string,
  task_id: string,
  completed: boolean,
): Promise<void> {
  if (!child_id || !task_id) return;
  // task_id 必须是 UUID 且属于该孩子的 responsibility 模板
  const t = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "NinoGame".task_templates
      WHERE id::text = $1 AND child_id = $2 AND category = 'responsibility'`,
    [task_id, child_id],
  );
  if (t.rows.length === 0) {
    app.log.debug(
      { child_id, task_id },
      "checklist_tick 任务不是 responsibility 模板, 跳过",
    );
    return;
  }
  try {
    await pool.query(
      `INSERT INTO "NinoGame".responsibility_checks
         (task_id, child_id, check_date, completed)
       VALUES ($1, $2, CURRENT_DATE, $3)
       ON CONFLICT (task_id, check_date)
         DO UPDATE SET completed = EXCLUDED.completed, checked_at = NOW()`,
      [task_id, child_id, completed],
    );
    app.log.info(
      { child_id, task_id, completed, task: t.rows[0].name },
      "responsibility_check upserted",
    );
  } catch (err) {
    app.log.warn({ err, child_id, task_id }, "upsert responsibility_check failed");
  }
}

// ── routes ─────────────────────────────────────────────────────
export async function registerTaskRoutes(app: FastifyInstance) {
  // ── 列出该孩子的所有模板 ────────────────────────────────────
  app.get("/api/tasks", { preHandler: app.parentAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const child_id = q.child_id;
    if (!child_id) return reply.badRequest("child_id required");
    if (!(await ensureChildOwnership(req.parent!.sub, child_id))) {
      return reply.forbidden("孩子不属于当前家长");
    }
    const r = await pool.query<TaskRow>(
      `SELECT id, child_id, name, category, reward_tokens, daily_max_completions,
              verification, schedule, active
         FROM "NinoGame".task_templates
        WHERE child_id = $1
        ORDER BY active DESC, category, name`,
      [child_id],
    );
    return { tasks: r.rows };
  });

  // ── 创建模板 ────────────────────────────────────────────────
  app.post("/api/tasks", { preHandler: app.parentAuth }, async (req, reply) => {
    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const data = parsed.data;
    if (!(await ensureChildOwnership(req.parent!.sub, data.child_id))) {
      return reply.forbidden("孩子不属于当前家长");
    }
    // 责任类任务: reward_tokens 强制为 0 (§8.6)
    if (data.category === "responsibility" && data.reward_tokens > 0) {
      return reply.badRequest("责任类任务不挣 token, reward_tokens 必须为 0");
    }
    const r = await pool.query<TaskRow>(
      `INSERT INTO "NinoGame".task_templates
         (child_id, name, category, reward_tokens, daily_max_completions,
          verification, schedule, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, child_id, name, category, reward_tokens, daily_max_completions,
                 verification, schedule, active`,
      [
        data.child_id, data.name, data.category, data.reward_tokens,
        data.daily_max_completions, data.verification, data.schedule, data.active,
      ],
    );
    const task = r.rows[0];
    const pushed = await pushTasksUpdate(data.child_id);
    app.log.info({ task_id: task.id, child_id: data.child_id, pushed }, "task created");
    return { task, pushed };
  });

  // ── 更新模板 ────────────────────────────────────────────────
  app.put("/api/tasks/:id", { preHandler: app.parentAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const t0 = await pool.query<{ child_id: string; category: string }>(
      `SELECT t.child_id, t.category FROM "NinoGame".task_templates t
         JOIN "NinoGame".children c ON c.id = t.child_id
        WHERE t.id = $1 AND c.parent_id = $2`,
      [id, req.parent!.sub],
    );
    if (t0.rows.length === 0) return reply.notFound("任务不存在或不归当前家长");
    const child_id = t0.rows[0].child_id;

    const parsed = UpdateTaskBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const d = parsed.data;
    const finalCategory = d.category ?? t0.rows[0].category;
    const finalReward = d.reward_tokens;
    if (finalCategory === "responsibility" && finalReward && finalReward > 0) {
      return reply.badRequest("责任类任务不挣 token, reward_tokens 必须为 0");
    }

    const r = await pool.query<TaskRow>(
      `UPDATE "NinoGame".task_templates
          SET name                  = COALESCE($2, name),
              category              = COALESCE($3, category),
              reward_tokens         = COALESCE($4, reward_tokens),
              daily_max_completions = COALESCE($5, daily_max_completions),
              verification          = COALESCE($6, verification),
              schedule              = COALESCE($7, schedule),
              active                = COALESCE($8, active)
        WHERE id = $1
        RETURNING id, child_id, name, category, reward_tokens, daily_max_completions,
                  verification, schedule, active`,
      [
        id,
        d.name ?? null,
        d.category ?? null,
        d.reward_tokens ?? null,
        d.daily_max_completions ?? null,
        d.verification ?? null,
        d.schedule ?? null,
        d.active ?? null,
      ],
    );
    const pushed = await pushTasksUpdate(child_id);
    app.log.info({ task_id: id, child_id, pushed }, "task updated");
    return { task: r.rows[0], pushed };
  });

  // ── 删除模板 ────────────────────────────────────────────────
  app.delete("/api/tasks/:id", { preHandler: app.parentAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const t0 = await pool.query<{ child_id: string }>(
      `SELECT t.child_id FROM "NinoGame".task_templates t
         JOIN "NinoGame".children c ON c.id = t.child_id
        WHERE t.id = $1 AND c.parent_id = $2`,
      [id, req.parent!.sub],
    );
    if (t0.rows.length === 0) return reply.notFound("任务不存在或不归当前家长");
    const child_id = t0.rows[0].child_id;
    // CASCADE 会一并删 task_completions / responsibility_checks
    await pool.query(`DELETE FROM "NinoGame".task_templates WHERE id = $1`, [id]);
    const pushed = await pushTasksUpdate(child_id);
    app.log.info({ task_id: id, child_id, pushed }, "task deleted");
    return { ok: true, pushed };
  });

  // ── 列出待审批 (含已审批可切) ──────────────────────────────
  app.get(
    "/api/task-completions",
    { preHandler: app.parentAuth },
    async (req) => {
      const q = (req.query ?? {}) as Record<string, string>;
      const status = q.status || "pending";
      const r = await pool.query<
        CompletionRow & {
          child_username: string;
          display_name: string | null;
          task_name: string;
          task_category: string;
          reward_tokens: number;
        }
      >(
        `SELECT tc.*, c.username AS child_username, c.display_name,
                t.name AS task_name, t.category AS task_category,
                t.reward_tokens
           FROM "NinoGame".task_completions tc
           JOIN "NinoGame".children c ON c.id = tc.child_id
           JOIN "NinoGame".task_templates t ON t.id = tc.task_id
          WHERE c.parent_id = $1
            AND ($2 = 'all' OR tc.status = $2)
          ORDER BY tc.created_at DESC LIMIT 100`,
        [req.parent!.sub, status],
      );
      return { completions: r.rows };
    },
  );

  // ── 批准: 写 ledger 加 token + 标记 approved ────────────────
  app.post(
    "/api/task-completions/:id/approve",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = ApproveBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { reward_override, comment } = parsed.data;

      const cq = await pool.query<{
        id: string; child_id: string; task_id: string; status: string;
        reward_tokens: number; task_name: string;
      }>(
        `SELECT tc.id, tc.child_id, tc.task_id, tc.status,
                t.reward_tokens, t.name AS task_name
           FROM "NinoGame".task_completions tc
           JOIN "NinoGame".task_templates t ON t.id = tc.task_id
           JOIN "NinoGame".children c ON c.id = tc.child_id
          WHERE tc.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (cq.rows.length === 0) return reply.notFound("完成记录不存在或不归当前家长");
      const c = cq.rows[0];
      if (c.status !== "pending") {
        return reply.conflict(`已处理 (status=${c.status})`);
      }
      const reward = Math.max(
        0,
        Math.min(500, reward_override ?? c.reward_tokens),
      );

      // 事务: ledger + 标 approved + 更新 wallet
      const client = await pool.connect();
      let newBalance = 0;
      try {
        await client.query("BEGIN");
        let realDelta = 0;
        if (reward > 0) {
          const w = await client.query<{ id: string; balance: number }>(
            `SELECT id, balance FROM "NinoGame".wallets
              WHERE child_id = $1 FOR UPDATE`,
            [c.child_id],
          );
          if (w.rows.length === 0) {
            await client.query("ROLLBACK");
            return reply.notFound("钱包不存在");
          }
          const before = Number(w.rows[0].balance);
          newBalance = before + reward;
          realDelta = newBalance - before;
          await client.query(
            `INSERT INTO "NinoGame".token_ledger
               (wallet_id, delta, balance_after, reason, ref_id, occurred_at)
             VALUES ($1, $2, $3, 'task_reward', $4, NOW())`,
            [w.rows[0].id, realDelta, newBalance, c.id],
          );
          await client.query(
            `UPDATE "NinoGame".wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
            [newBalance, w.rows[0].id],
          );
        } else {
          const w = await client.query<{ balance: number }>(
            `SELECT balance FROM "NinoGame".wallets WHERE child_id = $1`,
            [c.child_id],
          );
          newBalance = Number(w.rows[0]?.balance ?? 0);
        }
        await client.query(
          `UPDATE "NinoGame".task_completions
              SET status = 'approved',
                  parent_decision_at = NOW(),
                  parent_comment = $2,
                  reward_granted = $3
            WHERE id = $1`,
          [c.id, comment ?? null, reward],
        );
        await client.query("COMMIT");
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }

      // 推 wallet_update 给所有在线设备
      let pushed = 0;
      if (reward > 0) {
        const devs = await pool.query<{ id: string }>(
          `SELECT d.id FROM "NinoGame".devices d
             JOIN "NinoGame".device_bindings b ON b.device_id = d.id
            WHERE b.child_id = $1 AND d.agent_token IS NOT NULL`,
          [c.child_id],
        );
        for (const d of devs.rows) {
          if (
            pushToDevice(d.id, {
              type: "wallet_update",
              payload: {
                balance: newBalance,
                reason: "task_reward",
                delta: reward,
                comment: `任务奖励: ${c.task_name}`,
              },
            })
          ) pushed++;
        }
      }
      // 推家长浏览器
      publishToParent({
        parent_id: req.parent!.sub,
        child_id: c.child_id,
        device_id: null,
        event_type: "token_credit",
        payload: {
          amount: reward,
          reason: "task_reward",
          comment: `任务: ${c.task_name}`,
          new_balance: newBalance,
        },
        occurred_at: new Date().toISOString(),
      });

      app.log.info(
        { completion_id: id, child_id: c.child_id, reward, balance: newBalance, pushed },
        "task_completion approved",
      );
      return { ok: true, reward, balance: newBalance, pushed };
    },
  );

  // ── 拒绝 ────────────────────────────────────────────────────
  app.post(
    "/api/task-completions/:id/reject",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parsed = RejectBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest("请求体格式错误");
      }
      const cq = await pool.query<{ id: string; child_id: string; status: string }>(
        `SELECT tc.id, tc.child_id, tc.status FROM "NinoGame".task_completions tc
           JOIN "NinoGame".children c ON c.id = tc.child_id
          WHERE tc.id = $1 AND c.parent_id = $2`,
        [id, req.parent!.sub],
      );
      if (cq.rows.length === 0) return reply.notFound("完成记录不存在");
      if (cq.rows[0].status !== "pending") {
        return reply.conflict(`已处理 (status=${cq.rows[0].status})`);
      }
      await pool.query(
        `UPDATE "NinoGame".task_completions
            SET status = 'rejected',
                parent_decision_at = NOW(),
                parent_comment = $2,
                reward_granted = 0
          WHERE id = $1`,
        [id, parsed.data.comment ?? null],
      );
      app.log.info({ completion_id: id }, "task_completion rejected");
      return { ok: true };
    },
  );

  // ── 责任清单完成历史 (家长可读) ────────────────────────────
  app.get(
    "/api/responsibility-checks",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const q = (req.query ?? {}) as Record<string, string>;
      const child_id = q.child_id;
      if (!child_id) return reply.badRequest("child_id required");
      if (!(await ensureChildOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const days = Math.max(1, Math.min(60, Number(q.days || 14)));
      // 按 (date, task) 二维返回, 前端做日历; 也带任务总数方便算完成率
      const r = await pool.query<{
        check_date: string;
        task_id: string;
        task_name: string;
        completed: boolean;
      }>(
        `SELECT rc.check_date::text, rc.task_id::text, t.name AS task_name, rc.completed
           FROM "NinoGame".responsibility_checks rc
           JOIN "NinoGame".task_templates t ON t.id = rc.task_id
          WHERE rc.child_id = $1
            AND rc.check_date >= CURRENT_DATE - ($2::int || ' days')::interval
          ORDER BY rc.check_date DESC, t.name`,
        [child_id, days],
      );
      const respTasks = await pool.query<{ id: string; name: string }>(
        `SELECT id::text, name FROM "NinoGame".task_templates
          WHERE child_id = $1 AND category = 'responsibility' AND active = TRUE
          ORDER BY name`,
        [child_id],
      );
      return {
        checks: r.rows,
        responsibility_tasks: respTasks.rows,
        days,
      };
    },
  );
}
