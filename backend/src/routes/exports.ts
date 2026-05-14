/** /api/children/:id/export/:kind: 家长数据导出 (v0.4.3, P4 完成).
 *
 * 目的: 让家长能把自家数据下下来 — 备份、外部分析、给孩子看具体数字
 *      (§1.1 透明可见). 不限频率, 但只让家长拉自家孩子的数据.
 *
 * 5 个 kind:
 *   daily             - 每天 active 时长 + 扣分 (基于 app_sessions + ledger 聚合)
 *   ledger            - 完整 token 变动账本 (含 app_consumption)
 *   app-sessions      - 每次应用前台时段
 *   events            - 审计事件 (block / pin_fail / behavior_anomaly / ...)
 *   task-completions  - 任务申报历史
 *
 * 格式:
 *   ?format=json (默认) → application/json, 直接吃数组
 *   ?format=csv         → text/csv;charset=utf-8, 带 BOM 让 Excel 直接认中文
 *
 * 时间范围:
 *   ?days=N (默认 30, 上限 365) — 简单常用
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD — 精确范围 (优先级高)
 *
 * 大小预估: 30 天 ledger ~3k 行 (含 app_consumption), events ~5k 行,
 *           app_sessions 1.5k 行 — JSON 几 MB, 不流式也 OK; 真大数据上限被
 *           365 天 + Math.min 阻断。
 */
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

type ExportKind =
  | "daily"
  | "ledger"
  | "app-sessions"
  | "events"
  | "task-completions";

const KIND_LABEL: Record<ExportKind, string> = {
  daily: "每日聚合",
  ledger: "token 账本",
  "app-sessions": "应用使用时段",
  events: "事件日志",
  "task-completions": "任务申报记录",
};

const VALID_KINDS: ExportKind[] = [
  "daily",
  "ledger",
  "app-sessions",
  "events",
  "task-completions",
];

async function ensureOwnership(parent_id: string, child_id: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "NinoGame".children WHERE id = $1 AND parent_id = $2`,
    [child_id, parent_id],
  );
  return Number(r.rows[0].count) > 0;
}

interface DateRange {
  from: string;
  to: string;
  days_label: string;
}

function parseRange(q: Record<string, string>): DateRange | { error: string } {
  const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (q.from || q.to) {
    if (!q.from || !q.to || !isIso(q.from) || !isIso(q.to)) {
      return { error: "from / to 必须同时给 YYYY-MM-DD 格式" };
    }
    if (q.from > q.to) return { error: "from 不能晚于 to" };
    return { from: q.from, to: q.to, days_label: `${q.from} 至 ${q.to}` };
  }
  const days = Math.max(1, Math.min(365, Number(q.days) || 30));
  return {
    // 转 ISO 时区由 PG 自己按服务器 TZ 处理, days 是日历天数
    from: "",
    to: "",
    days_label: `最近 ${days} 天`,
  };
}

/** 把任一 JS 值序列化成 CSV 单元格。
 *  - 字符串含逗号/引号/换行 → 双引号包 + 内部双引号转义
 *  - 对象 / 数组 → JSON.stringify (然后按字符串规则转义)
 *  - null/undefined → 空字符串
 *  - 其它 → String(v)
 */
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "object") {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  } else {
    s = String(v);
  }
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
  // BOM 让 Excel 默认按 UTF-8 解析, 不带它中文会乱码
  const BOM = "﻿";
  const lines: string[] = [headers.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  return BOM + lines.join("\r\n");
}

/** 拉 5 类数据中的一类, 统一返回 {headers, rows} (rows 是普通 object). */
async function fetchData(
  kind: ExportKind,
  child_id: string,
  days: number,
  from?: string,
  to?: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  // 时间过滤片段, 复用所有 kind. 优先 from/to, 否则 days
  const timeClause = from && to
    ? `BETWEEN $2::date AND $3::date + INTERVAL '1 day' - INTERVAL '1 microsecond'`
    : `>= CURRENT_DATE - ($2::int - 1 || ' days')::interval`;
  const params: unknown[] = from && to ? [child_id, from, to] : [child_id, days];

  switch (kind) {
    case "daily": {
      // 复用现有 /reports/daily 的逻辑, 直接 SQL 出每日聚合
      const sessions = await pool.query<{
        date: string;
        active_seconds: string;
        session_count: string;
      }>(
        `SELECT (started_at::date)::text AS date,
                COALESCE(SUM(active_seconds), 0)::text AS active_seconds,
                COUNT(*)::text AS session_count
           FROM "NinoGame".app_sessions
          WHERE child_id = $1 AND started_at ${timeClause}
          GROUP BY started_at::date
          ORDER BY started_at::date`,
        params,
      );
      const ledger = await pool.query<{ date: string; tokens_consumed: string }>(
        `SELECT (l.occurred_at::date)::text AS date,
                COALESCE(SUM(-l.delta), 0)::text AS tokens_consumed
           FROM "NinoGame".token_ledger l
           JOIN "NinoGame".wallets w ON w.id = l.wallet_id
          WHERE w.child_id = $1
            AND l.reason = 'app_consumption'
            AND l.occurred_at ${timeClause}
          GROUP BY l.occurred_at::date`,
        params,
      );
      const map = new Map<string, Record<string, unknown>>();
      for (const r of sessions.rows) {
        map.set(r.date, {
          date: r.date,
          active_seconds: Number(r.active_seconds),
          tokens_consumed: 0,
          session_count: Number(r.session_count),
        });
      }
      for (const r of ledger.rows) {
        const ex = map.get(r.date);
        if (ex) ex.tokens_consumed = Number(r.tokens_consumed);
        else map.set(r.date, {
          date: r.date,
          active_seconds: 0,
          tokens_consumed: Number(r.tokens_consumed),
          session_count: 0,
        });
      }
      const rows = Array.from(map.values()).sort((a, b) =>
        String(a.date).localeCompare(String(b.date)),
      );
      return {
        headers: ["date", "active_seconds", "tokens_consumed", "session_count"],
        rows,
      };
    }

    case "ledger": {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT l.id::text AS id,
                l.delta,
                l.balance_after,
                l.reason,
                l.ref_id,
                l.occurred_at::text AS occurred_at
           FROM "NinoGame".token_ledger l
           JOIN "NinoGame".wallets w ON w.id = l.wallet_id
          WHERE w.child_id = $1
            AND l.occurred_at ${timeClause}
          ORDER BY l.occurred_at`,
        params,
      );
      return {
        headers: ["id", "delta", "balance_after", "reason", "ref_id", "occurred_at"],
        rows: r.rows,
      };
    }

    case "app-sessions": {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT id::text AS id,
                app_identifier,
                category,
                started_at::text AS started_at,
                ended_at::text AS ended_at,
                active_seconds,
                tokens_consumed,
                device_id::text AS device_id
           FROM "NinoGame".app_sessions
          WHERE child_id = $1
            AND started_at ${timeClause}
          ORDER BY started_at`,
        params,
      );
      return {
        headers: [
          "id", "app_identifier", "category", "started_at", "ended_at",
          "active_seconds", "tokens_consumed", "device_id",
        ],
        rows: r.rows,
      };
    }

    case "events": {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT id::text AS id,
                event_type,
                payload,
                device_id::text AS device_id,
                occurred_at::text AS occurred_at
           FROM "NinoGame".events
          WHERE child_id = $1
            AND occurred_at ${timeClause}
          ORDER BY occurred_at`,
        params,
      );
      return {
        headers: ["id", "event_type", "payload", "device_id", "occurred_at"],
        rows: r.rows,
      };
    }

    case "task-completions": {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT tc.id::text AS id,
                t.name AS task_name,
                t.category AS task_category,
                tc.status,
                tc.child_note,
                tc.parent_comment,
                tc.reward_granted,
                tc.parent_decision_at::text AS parent_decision_at,
                tc.created_at::text AS created_at
           FROM "NinoGame".task_completions tc
           LEFT JOIN "NinoGame".task_templates t ON t.id = tc.task_id
          WHERE tc.child_id = $1
            AND tc.created_at ${timeClause}
          ORDER BY tc.created_at`,
        params,
      );
      return {
        headers: [
          "id", "task_name", "task_category", "status",
          "child_note", "parent_comment", "reward_granted",
          "parent_decision_at", "created_at",
        ],
        rows: r.rows,
      };
    }
  }
}

export async function registerExportRoutes(app: FastifyInstance) {
  app.get(
    "/api/children/:id/export/:kind",
    { preHandler: app.parentAuth },
    async (req, reply) => {
      const params = req.params as { id: string; kind: string };
      const child_id = params.id;
      const kind = params.kind as ExportKind;
      if (!VALID_KINDS.includes(kind)) {
        return reply.badRequest(`kind 必须是 ${VALID_KINDS.join(" / ")}`);
      }
      if (!(await ensureOwnership(req.parent!.sub, child_id))) {
        return reply.forbidden("孩子不属于当前家长");
      }
      const q = (req.query ?? {}) as Record<string, string>;
      const format = q.format === "csv" ? "csv" : "json";
      const range = parseRange(q);
      if ("error" in range) return reply.badRequest(range.error);

      const days = Math.max(1, Math.min(365, Number(q.days) || 30));
      const { headers, rows } = await fetchData(
        kind,
        child_id,
        days,
        range.from || undefined,
        range.to || undefined,
      );

      const stamp = new Date().toISOString().slice(0, 10);
      const fileBase = `nino_${kind}_${stamp}`;

      app.log.info(
        {
          child_id, kind, format,
          rows: rows.length,
          range: range.days_label,
        },
        "data export",
      );

      if (format === "csv") {
        const body = rowsToCsv(headers, rows);
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header(
          "Content-Disposition",
          `attachment; filename="${fileBase}.csv"`,
        );
        return reply.send(body);
      }

      // json: 把 metadata 也带上 (导出范围 + 行数 + 字段顺序),
      // 这样脱机再分析时不需要回查 schema
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${fileBase}.json"`,
      );
      return reply.send({
        kind,
        kind_label: KIND_LABEL[kind],
        range: range.days_label,
        exported_at: new Date().toISOString(),
        row_count: rows.length,
        columns: headers,
        rows,
      });
    },
  );
}
