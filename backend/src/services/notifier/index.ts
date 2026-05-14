/** 推送 notifier (v0.4.0+).
 *
 * 统一入口: notify({severity, subject, body, dedupe_key?}).
 * 读 admin_settings(key='push'), 启用的 channel 各发一份; 不启用的跳过。
 *
 * 限频: 同 dedupe_key 在 5 分钟内只发一次 (内存 LRU);
 * 没传 dedupe_key 时不去重 (测试发送 / 手动触发).
 *
 * 失败软失败 — 日志记录, 不抛, 不阻业务流.
 */
import type { FastifyBaseLogger } from "fastify";
import { getSetting } from "../admin_settings.js";
import type { AdminPushConfig } from "./types.js";
import { sendWechatWork } from "./wechat_work.js";
import { sendSmtp } from "./smtp.js";

export type Severity = "info" | "warn" | "alert";

export interface NotifyInput {
  severity: Severity;
  subject: string;
  body: string;
  /** 限频去重 key; 同 key 5 分钟内只发一次. 不传则不去重. */
  dedupe_key?: string;
  /** 仅给某 channel 发 (用于测试发送). 不传则两个 channel 都发. */
  only?: "wechat_work" | "smtp";
}

interface NotifyResult {
  sent: { channel: string; ok: boolean; error?: string }[];
  skipped: { channel: string; reason: string }[];
}

const DEDUPE_TTL_MS = 5 * 60 * 1000;
const _dedupe = new Map<string, number>();

function shouldSkipDedupe(key: string): boolean {
  const now = Date.now();
  // 顺手清过期
  for (const [k, t] of _dedupe) {
    if (now - t > DEDUPE_TTL_MS) _dedupe.delete(k);
  }
  const last = _dedupe.get(key);
  if (last && now - last < DEDUPE_TTL_MS) return true;
  _dedupe.set(key, now);
  return false;
}

export async function notify(
  logger: FastifyBaseLogger,
  input: NotifyInput,
): Promise<NotifyResult> {
  const result: NotifyResult = { sent: [], skipped: [] };

  if (input.dedupe_key && shouldSkipDedupe(input.dedupe_key)) {
    result.skipped.push({ channel: "all", reason: "dedupe (5min cooldown)" });
    return result;
  }

  const cfg = await getSetting<AdminPushConfig>("push");
  if (!cfg) {
    result.skipped.push({ channel: "all", reason: "no push config" });
    return result;
  }

  const want = (ch: "wechat_work" | "smtp") => !input.only || input.only === ch;

  // 企微 webhook
  if (want("wechat_work") && cfg.wechat_work.enabled && cfg.wechat_work.webhook_url) {
    try {
      await sendWechatWork(cfg.wechat_work.webhook_url, input);
      result.sent.push({ channel: "wechat_work", ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "notifier: 企微 push 失败");
      result.sent.push({ channel: "wechat_work", ok: false, error: msg });
    }
  } else if (want("wechat_work")) {
    result.skipped.push({
      channel: "wechat_work",
      reason: cfg.wechat_work.enabled ? "no webhook_url" : "disabled",
    });
  }

  // SMTP
  if (want("smtp") && cfg.smtp.enabled && cfg.smtp.host && cfg.smtp.from) {
    try {
      await sendSmtp(cfg.smtp, input);
      result.sent.push({ channel: "smtp", ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "notifier: SMTP push 失败");
      result.sent.push({ channel: "smtp", ok: false, error: msg });
    }
  } else if (want("smtp")) {
    result.skipped.push({
      channel: "smtp",
      reason: cfg.smtp.enabled ? "no host/from" : "disabled",
    });
  }

  return result;
}

export type { AdminPushConfig } from "./types.js";
