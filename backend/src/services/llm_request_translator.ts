/** 申请翻译 (CLAUDE.md §12.2 LLM 翻译器 / §13.1 申请审批主流程)。
 *
 * 输入: 孩子的自然语言 (例 "我作业写完了想玩半小时 PvZ")
 * 输出: 严格 JSON {duration_minutes, activity, claimed_completions, tone, summary}
 *
 * LLM 调用失败 / 返回非 JSON / 未配置 → 返回 null, 调用方降级到只显示原文。
 */
import { chat, LlmNotConfiguredError, LlmRequestError } from "./llm.js";

const SYSTEM_PROMPT = `你是 NinoGame 家长控制系统的助手。
孩子会用自然语言向家长申请游戏 / 视频 / 其它消遣时间。
把孩子的话翻译成下面的 JSON 结构, 给家长看一句客观摘要。

输出**仅** JSON, 不要 markdown 代码块, 不要解释。结构:
{
  "duration_minutes": <整数, 孩子请求的分钟数, 默认 30, 范围 5-240>,
  "activity": <字符串, 简短活动名, 如 "PvZ" / "B 站看视频" / "和同学打游戏">,
  "claimed_completions": [<字符串>],  // 孩子声称已完成的事, 如 ["homework", "practice"]
  "tone": <"polite" | "demanding" | "negotiating">,
  "summary": <一句话给家长的客观陈述, 不带情绪, 不带建议, 30 字内>
}

例:
输入: "我作业写完了想玩半小时 PvZ"
输出: {"duration_minutes":30,"activity":"PvZ","claimed_completions":["homework"],"tone":"polite","summary":"孩子声称完成作业, 申请 30 分钟 PvZ"}

输入: "妈妈我想玩游戏!!"
输出: {"duration_minutes":30,"activity":"游戏","claimed_completions":[],"tone":"demanding","summary":"孩子无具体理由申请游戏时间"}

输入: "我想看 1 小时 B 站, 写完日记了"
输出: {"duration_minutes":60,"activity":"B 站看视频","claimed_completions":["diary"],"tone":"polite","summary":"孩子声称写完日记, 申请 60 分钟 B 站"}`;

export interface TranslatedRequest {
  duration_minutes: number;
  activity: string;
  claimed_completions: string[];
  tone: "polite" | "demanding" | "negotiating";
  summary: string;
}

/** 尝试翻译申请文本; 失败返回 null. */
export async function translateUnlockRequest(
  parent_id: string,
  request_text: string,
): Promise<TranslatedRequest | null> {
  if (!request_text || request_text.trim().length === 0) return null;
  try {
    const out = await chat(
      parent_id,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: request_text.trim().slice(0, 500) },
      ],
      { temperature: 0.2, max_tokens: 256, timeout_ms: 15_000 },
    );
    const parsed = parseLlmJson(out);
    if (!parsed) return null;
    return normalize(parsed);
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      // 没配 LLM 不是错, 静默返回 null
      return null;
    }
    if (err instanceof LlmRequestError) {
      // 调用失败 (超时 / 网络 / API key 失效), 调用方降级
      return null;
    }
    throw err;
  }
}

/** LLM 偶尔会把 JSON 包在 ``` 或前后加废话, 容错解析。 */
function parseLlmJson(text: string): Record<string, unknown> | null {
  // 去除常见 markdown 包装
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  }
  // 截到第一个 { 到最后一个 }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  s = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(s);
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalize(obj: Record<string, unknown>): TranslatedRequest {
  let duration = Number(obj.duration_minutes);
  if (!Number.isFinite(duration)) duration = 30;
  duration = Math.max(5, Math.min(240, Math.round(duration)));

  const activity = typeof obj.activity === "string" && obj.activity.length > 0
    ? obj.activity.slice(0, 64) : "活动";

  let claimed: string[] = [];
  if (Array.isArray(obj.claimed_completions)) {
    claimed = obj.claimed_completions
      .filter((x) => typeof x === "string")
      .map((x) => (x as string).slice(0, 32))
      .slice(0, 5);
  }

  const tone = obj.tone === "demanding" || obj.tone === "negotiating" || obj.tone === "polite"
    ? obj.tone : "polite";

  const summary = typeof obj.summary === "string" && obj.summary.length > 0
    ? obj.summary.slice(0, 200) : `孩子申请 ${duration} 分钟 ${activity}`;

  return { duration_minutes: duration, activity, claimed_completions: claimed, tone, summary };
}
