/** LLM 应用分类 (CLAUDE.md §9.3 / §12.3).
 *
 * Agent 遇到本地未分类的前台 exe → 入 unknown_apps_queue → 周期推 server
 *  → 本 service 调 LLM 分类 → 写 server app_categories + 推回 Agent.
 *
 * 失败时返回 null, 调用方降级 (该 app 仍是 unknown, 下次再尝试).
 */
import { chat, LlmNotConfiguredError, LlmRequestError } from "./llm.js";

const SYSTEM_PROMPT = `你是 NinoGame 应用分类助手。把孩子在 Windows / Android 上前台运行的应用归类, 并给出友好显示名 (家长后台报表用)。

输出**仅** JSON, 不要 markdown 代码块, 不要解释。结构:
{
  "display_name": <中文/英文友好名, 家长一眼能认出, 不要带 .exe 后缀, 不超过 32 字>,
  "category": "consumption" | "productive" | "neutral",
  "sub_type": <短词, 如 "game" / "video" / "short_video" / "reading" / "code" / "create" / "browser" / "messaging" / "system" / "music">,
  "confidence": <0-1 浮点数, 标记不确定时 ≤0.6>,
  "reasoning": <一句话简短说明, 30 字内>
}

display_name 取名规则:
- 优先用大众认知度最高的产品名 (中文产品用中文, 国际产品用英文)
- 例: chrome.exe → "Google Chrome"; bilibili.exe → "哔哩哔哩"; code.exe → "Visual Studio Code"
- 完全不认识时 → 沿用原 exe 名 (不含后缀, 首字母大写), 如 myapp.exe → "Myapp"

category 含义:
- consumption: 消遣类 (游戏 / 视频 / 短视频 / 漫画 / 社交娱乐)
- productive: 学习类 (代码编辑器 / 学习软件 / 阅读应用 / 创作工具)
- neutral: 中性 (浏览器 / 系统进程 / 即时通讯 / 笔记 / 音乐播放器)

例:
输入: app=plantsvszombies.exe; window=植物大战僵尸
输出: {"display_name":"植物大战僵尸","category":"consumption","sub_type":"game","confidence":0.99,"reasoning":"PvZ 桌面游戏"}

输入: app=Code.exe; window=main.py - Visual Studio Code
输出: {"display_name":"Visual Studio Code","category":"productive","sub_type":"code","confidence":0.98,"reasoning":"VSCode 代码编辑器"}

输入: app=chrome.exe; window=Google
输出: {"display_name":"Google Chrome","category":"neutral","sub_type":"browser","confidence":0.95,"reasoning":"Chrome 浏览器, 用途中性"}

输入: app=Bilibili.exe; window=B站直播
输出: {"display_name":"哔哩哔哩","category":"consumption","sub_type":"video","confidence":0.92,"reasoning":"B 站视频客户端"}

输入: app=KindleForPC.exe; window=Kindle - 第三章
输出: {"display_name":"Kindle","category":"productive","sub_type":"reading","confidence":0.97,"reasoning":"Kindle 桌面阅读应用"}

输入: app=unknown_proc.exe; window=
输出: {"display_name":"Unknown_proc","category":"neutral","sub_type":"system","confidence":0.3,"reasoning":"无窗口标题, 倾向中性兜底"}`;

export interface AppToClassify {
  app_identifier: string;
  exe_path?: string | null;
  window_title?: string | null;
}

export interface LlmCategory {
  category: "consumption" | "productive" | "neutral";
  sub_type: string;
  confidence: number;
  reasoning: string;
  display_name: string;
}

/** 单个分类; null 表示失败/未配置. */
export async function classifyApp(
  app: AppToClassify,
): Promise<LlmCategory | null> {
  const userPrompt = buildUserPrompt(app);
  try {
    const out = await chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.1, max_tokens: 160, timeout_ms: 15_000 },
    );
    const parsed = parseLlmJson(out);
    if (!parsed) return null;
    return normalize(parsed);
  } catch (err) {
    if (err instanceof LlmNotConfiguredError || err instanceof LlmRequestError) {
      return null;
    }
    throw err;
  }
}

/** 批量分类: 并行限流 5 个, 不让任意慢请求拖累。返回每个 app 的 (LlmCategory | null). */
export async function classifyBatch(
  apps: AppToClassify[],
  concurrency: number = 5,
): Promise<Array<{ app_identifier: string; result: LlmCategory | null }>> {
  const out: Array<{ app_identifier: string; result: LlmCategory | null }> = [];
  for (let i = 0; i < apps.length; i += concurrency) {
    const batch = apps.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (a) => ({
        app_identifier: a.app_identifier,
        result: await classifyApp(a),
      })),
    );
    out.push(...results);
  }
  return out;
}

function buildUserPrompt(app: AppToClassify): string {
  const w = (app.window_title || "").slice(0, 200);
  const p = (app.exe_path || "").slice(0, 200);
  return `app=${app.app_identifier}${p ? `; path=${p}` : ""}${w ? `; window=${w}` : ""}`;
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

function normalize(obj: Record<string, unknown>): LlmCategory {
  const cat = obj.category === "consumption" || obj.category === "productive" || obj.category === "neutral"
    ? obj.category : "neutral";
  const subType = typeof obj.sub_type === "string" && obj.sub_type.length > 0
    ? obj.sub_type.slice(0, 32) : "unknown";
  let conf = Number(obj.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;
  conf = Math.max(0, Math.min(1, conf));
  const reasoning = typeof obj.reasoning === "string" && obj.reasoning.length > 0
    ? obj.reasoning.slice(0, 200) : "";
  const displayName = typeof obj.display_name === "string" && obj.display_name.trim().length > 0
    ? obj.display_name.trim().slice(0, 128) : "";
  return { category: cat, sub_type: subType, confidence: conf, reasoning, display_name: displayName };
}
