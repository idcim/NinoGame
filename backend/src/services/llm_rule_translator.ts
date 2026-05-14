/** 一句话 → 规则 draft (CLAUDE.md §13 协商接口 / §12 LLM 翻译器).
 *
 * 输入: 家长一句话 ("禁止玩原神" / "晚上 9 点后不让玩王者荣耀")
 * 输出: RuleDraft (name, keywords[], action, schedule, message), 给前端预填
 *       编辑器, 家长再点保存才真正落库 — LLM 不直接写规则, 保留人工兜底。
 *
 * LLM 未配置 / 调用失败 / 返回非 JSON → 返回 null, 路由层降级到 422 提示。
 */
import { chat, LlmNotConfiguredError, LlmRequestError } from "./llm.js";

const SYSTEM_PROMPT = `你是 NinoGame 家长控制系统的规则助手。
家长会用一句话描述他想拦截的应用 / 游戏 / 网站, 你把它翻译成 NinoGame 规则草稿。

输出**仅** JSON, 不要 markdown 代码块, 不要解释。结构:
{
  "name": <规则展示名, 中文优先, 不超过 32 字>,
  "keywords": [<进程名/窗口标题关键词, 中英文别名都给, 全小写; 至少 2 个, 至多 12 个>],
  "action": "kill_and_warn" | "warn_only" | "kill_silent",
  "message": <孩子端弹窗文案, 100 字内, 没特别要求就给空字符串>,
  "schedule": {
    "mode": "always" | "windowed" | "disabled",
    "windows": [{"days": [0..6], "from": "HH:MM", "to": "HH:MM"}]
  },
  "reasoning": <一句话解释你为什么这么解析, 30 字内>
}

要点:
- keywords 必须**全小写**, 一行一个产品的不同写法 (中文名 / 英文名 / 进程名 / 简写)
  例: 原神 → ["原神", "genshin", "genshinimpact", "yuanshen"]
       Minecraft → ["minecraft", "我的世界", "javaw"]
       王者荣耀 → ["王者荣耀", "honor of kings", "wzry"]
- action 默认 "kill_and_warn"; 家长说"提示一下"/"温和"用 "warn_only"; "悄悄"用 "kill_silent"
- schedule.mode 默认 "always"; 家长提到时间段才用 "windowed"
- days 用 0=周日, 1=周一 ... 6=周六 (JS Date.getDay 习惯)
- 工作日 = [1,2,3,4,5]; 周末 = [0,6]; 每天 = [0,1,2,3,4,5,6]
- 跨午夜 (例 21:00→02:00) 直接用 from="21:00" to="02:00"
- 不确定就保守: keywords 偏多, schedule=always
- 不要把 explorer/chrome/msedge 这种通用进程加进 keywords

例:
输入: "禁止玩原神"
输出: {"name":"原神","keywords":["原神","genshin","genshinimpact","yuanshen"],"action":"kill_and_warn","message":"","schedule":{"mode":"always","windows":[]},"reasoning":"游戏全时段拦截"}

输入: "晚上 9 点到第二天早上 7 点不让玩王者荣耀"
输出: {"name":"王者荣耀","keywords":["王者荣耀","honor of kings","wzry","sgame"],"action":"kill_and_warn","message":"","schedule":{"mode":"windowed","windows":[{"days":[0,1,2,3,4,5,6],"from":"21:00","to":"07:00"}]},"reasoning":"夜间全天拦截"}

输入: "工作日不让玩 Minecraft, 周末可以"
输出: {"name":"Minecraft","keywords":["minecraft","我的世界","javaw","roblox"],"action":"kill_and_warn","message":"","schedule":{"mode":"windowed","windows":[{"days":[1,2,3,4,5],"from":"00:00","to":"23:59"}]},"reasoning":"工作日拦截, 周末放开"}

输入: "看到他开抖音温和提醒一下"
输出: {"name":"抖音","keywords":["抖音","douyin","tiktok"],"action":"warn_only","message":"短视频看一会儿就休息一下吧","schedule":{"mode":"always","windows":[]},"reasoning":"短视频只提醒不杀"}`;

export interface RuleDraft {
  name: string;
  keywords: string[];
  action: "kill_and_warn" | "warn_only" | "kill_silent";
  message: string;
  schedule: {
    mode: "always" | "windowed" | "disabled";
    windows: Array<{ days: number[]; from: string; to: string }>;
  };
  reasoning: string;
}

/** 尝试翻译一句话; 失败返回 null (LLM 未配置 / 调用错误 / 返回非法 JSON). */
export async function draftRuleFromText(
  parent_id: string,
  text: string,
): Promise<RuleDraft | null> {
  if (!text || text.trim().length === 0) return null;
  try {
    const out = await chat(
      parent_id,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text.trim().slice(0, 500) },
      ],
      { temperature: 0.2, max_tokens: 512, timeout_ms: 20_000 },
    );
    const parsed = parseLlmJson(out);
    if (!parsed) return null;
    return normalize(parsed);
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) return null;
    if (err instanceof LlmRequestError) return null;
    throw err;
  }
}

function parseLlmJson(text: string): Record<string, unknown> | null {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  }
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

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function normalize(obj: Record<string, unknown>): RuleDraft {
  const name = typeof obj.name === "string" && obj.name.trim().length > 0
    ? obj.name.trim().slice(0, 32)
    : "新规则";

  let keywords: string[] = [];
  if (Array.isArray(obj.keywords)) {
    const seen = new Set<string>();
    for (const k of obj.keywords) {
      if (typeof k !== "string") continue;
      const kw = k.trim().toLowerCase();
      if (!kw || seen.has(kw)) continue;
      // 屏蔽通用进程, 防 LLM 误把 chrome.exe / explorer 加进来
      if (["chrome.exe", "msedge.exe", "firefox.exe", "explorer.exe", "chrome", "msedge"].includes(kw)) continue;
      seen.add(kw);
      keywords.push(kw.slice(0, 64));
      if (keywords.length >= 12) break;
    }
  }
  // 至少 1 个关键词 (前端会校验 ≥1; LLM 没给关键词时让前端走人工填)
  if (keywords.length === 0) keywords = [];

  const action = obj.action === "warn_only" || obj.action === "kill_silent"
    ? obj.action
    : "kill_and_warn";

  const message = typeof obj.message === "string" ? obj.message.slice(0, 512) : "";

  const sch = (obj.schedule || {}) as Record<string, unknown>;
  const mode = sch.mode === "windowed" || sch.mode === "disabled" ? sch.mode : "always";
  let windows: Array<{ days: number[]; from: string; to: string }> = [];
  if (mode === "windowed" && Array.isArray(sch.windows)) {
    for (const w of sch.windows) {
      if (typeof w !== "object" || !w) continue;
      const ww = w as Record<string, unknown>;
      const days = Array.isArray(ww.days)
        ? ww.days
            .map((d) => Number(d))
            .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
      const from = typeof ww.from === "string" && HHMM_RE.test(ww.from) ? ww.from : null;
      const to = typeof ww.to === "string" && HHMM_RE.test(ww.to) ? ww.to : null;
      if (!from || !to || days.length === 0) continue;
      windows.push({ days: Array.from(new Set(days)).sort((a, b) => a - b), from, to });
      if (windows.length >= 6) break;
    }
  }
  // windowed 但一段都没有 → 退回 always (前端 UX 一致)
  const finalMode = mode === "windowed" && windows.length === 0 ? "always" : mode;

  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";

  return {
    name,
    keywords,
    action,
    message,
    schedule: { mode: finalMode, windows },
    reasoning,
  };
}
