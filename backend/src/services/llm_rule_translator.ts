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
同一条规则会同时下发到 Windows Agent 与 Android Agent, **keywords 必须覆盖两端**。

输出**仅** JSON, 不要 markdown 代码块, 不要解释。结构:
{
  "name": <规则展示名, 中文优先, 不超过 32 字>,
  "keywords": [<跨端匹配关键词, 全小写; 中英文别名 + Windows 进程名/窗口词 + Android 包名都给; 至少 3 个, 至多 12 个>],
  "action": "kill_and_warn" | "warn_only" | "kill_silent",
  "message": <孩子端弹窗文案, 100 字内, 没特别要求就给空字符串>,
  "schedule": {
    "mode": "always" | "windowed" | "disabled",
    "windows": [{"days": [0..6], "from": "HH:MM", "to": "HH:MM"}]
  },
  "reasoning": <一句话解释你为什么这么解析, 30 字内>
}

keywords 跨端策略 (Windows 按进程名/窗口标题 icontains, Android 按包名/LLM 应用名 icontains):
- 必给: 中文名 + 英文名 + Windows 进程名/窗口名 + Android 包名
  例: 微信 → ["微信", "wechat", "com.tencent.mm"]
       原神 → ["原神", "genshin", "genshinimpact", "yuanshen", "com.mihoyo.genshinimpact"]
       抖音 → ["抖音", "douyin", "tiktok", "com.ss.android.ugc.aweme"]
       王者荣耀 → ["王者荣耀", "honor of kings", "wzry", "sgame", "com.tencent.tmgp.sgame"]
       Minecraft → ["minecraft", "我的世界", "javaw", "com.mojang.minecraftpe"]
- Android 包名一般是 com.xxx.yyy 格式; 把家长说的应用对应的包名也加进去
- 包名加进去不会影响 Windows 端 — Windows 进程名永远不会写成 "com.xxx.yyy"
- 如果不知道 Android 包名就只给中英文名 + Windows 进程名, 不要瞎编

其它要点:
- keywords 必须**全小写**
- action 默认 "kill_and_warn"; 家长说"提示一下"/"温和"用 "warn_only"; "悄悄"用 "kill_silent"
- schedule.mode 默认 "always"; 家长提到时间段才用 "windowed"
- days 用 0=周日, 1=周一 ... 6=周六 (JS Date.getDay 习惯)
- 工作日 = [1,2,3,4,5]; 周末 = [0,6]; 每天 = [0,1,2,3,4,5,6]
- 跨午夜 (例 21:00→02:00) 直接用 from="21:00" to="02:00"
- 不确定就保守: keywords 偏多, schedule=always
- 不要把 explorer/chrome/msedge 这种通用进程加进 keywords

例:
输入: "禁止玩原神"
输出: {"name":"原神","keywords":["原神","genshin","genshinimpact","yuanshen","com.mihoyo.genshinimpact","com.mihoyo.hkrpg"],"action":"kill_and_warn","message":"","schedule":{"mode":"always","windows":[]},"reasoning":"跨端拦截原神 PC + 手机"}

输入: "晚上 9 点到第二天早上 7 点不让玩王者荣耀"
输出: {"name":"王者荣耀","keywords":["王者荣耀","honor of kings","wzry","sgame","com.tencent.tmgp.sgame"],"action":"kill_and_warn","message":"","schedule":{"mode":"windowed","windows":[{"days":[0,1,2,3,4,5,6],"from":"21:00","to":"07:00"}]},"reasoning":"夜间全天拦截"}

输入: "拦截手机抖音"
输出: {"name":"抖音","keywords":["抖音","douyin","tiktok","com.ss.android.ugc.aweme"],"action":"kill_and_warn","message":"","schedule":{"mode":"always","windows":[]},"reasoning":"短视频跨端拦截"}

输入: "看到他开微信温和提醒一下"
输出: {"name":"微信","keywords":["微信","wechat","wechatapp","com.tencent.mm"],"action":"warn_only","message":"用微信适度就好, 不要一直刷","schedule":{"mode":"always","windows":[]},"reasoning":"沟通工具只提醒不杀"}`;

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
  text: string,
): Promise<RuleDraft | null> {
  if (!text || text.trim().length === 0) return null;
  try {
    const out = await chat(
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
