/** SMTP 邮件推送.
 *
 * 用 nodemailer; SSL/TLS (port 465) 或 STARTTLS (port 587) 都支持.
 * 收件人现在 hardcode 为 SMTP user (admin 自己); 未来可扩展按 child / parent 路由.
 */
import nodemailer from "nodemailer";
import type { NotifyInput } from "./index.js";
import type { AdminPushConfig } from "./types.js";

const SEVERITY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warn: "⚠️",
  alert: "🚨",
};

// transporter cache (避免每次重建 TCP 连接)
let _cached: { signature: string; transporter: nodemailer.Transporter } | null = null;

function transporterFor(cfg: AdminPushConfig["smtp"]): nodemailer.Transporter {
  const sig = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}:${cfg.password.length}`;
  if (_cached?.signature === sig) return _cached.transporter;
  const t = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
  });
  _cached = { signature: sig, transporter: t };
  return t;
}

export async function sendSmtp(
  cfg: AdminPushConfig["smtp"],
  input: NotifyInput,
): Promise<void> {
  // 收件人: 默认发给 SMTP user 自己 (admin 邮箱); 未来按需扩展
  const to = cfg.user || cfg.from;
  if (!to) throw new Error("smtp: 无收件人 (user / from 都空)");

  const t = transporterFor(cfg);
  const emoji = SEVERITY_EMOJI[input.severity] || "ℹ️";
  await t.sendMail({
    from: cfg.from,
    to,
    subject: `${emoji} NinoGame · ${input.subject}`,
    text: `${input.body}\n\n--\nNinoGame (${input.severity})  ${new Date().toLocaleString("zh-CN")}`,
    html: `<div style="font-family:'Microsoft YaHei',Arial,sans-serif;max-width:600px;">
  <h3>${emoji} ${escapeHtml(input.subject)}</h3>
  <p style="color:#333;white-space:pre-wrap;">${escapeHtml(input.body)}</p>
  <p style="color:#888;font-size:12px;">NinoGame · ${input.severity} · ${escapeHtml(new Date().toLocaleString("zh-CN"))}</p>
</div>`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
