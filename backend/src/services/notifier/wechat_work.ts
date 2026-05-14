/** 企业微信群机器人 webhook 推送.
 *
 * Webhook URL 形如:
 *   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<uuid>
 *
 * 用 markdown 消息类型, 比 text 美观. 失败抛错 (caller 软失败).
 */
import type { NotifyInput } from "./index.js";

const SEVERITY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warn: "⚠️",
  alert: "🚨",
};

export async function sendWechatWork(
  webhookUrl: string,
  input: NotifyInput,
): Promise<void> {
  const emoji = SEVERITY_EMOJI[input.severity] || "ℹ️";
  // 企微 markdown 不支持 H1/H2, 只能用 # 标头模拟; 加色提示用 info/warning/comment
  const colorTag =
    input.severity === "alert"
      ? "<font color=\"warning\">"
      : input.severity === "warn"
        ? "<font color=\"warning\">"
        : "<font color=\"info\">";
  const content = [
    `### ${emoji} ${input.subject}`,
    "",
    `${colorTag}${input.body}</font>`,
    "",
    `> NinoGame · ${new Date().toLocaleString("zh-CN")}`,
  ].join("\n");

  const body = {
    msgtype: "markdown",
    markdown: { content },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`企微 errcode=${data.errcode}: ${data.errmsg}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
