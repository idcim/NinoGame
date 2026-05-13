/** 孩子 Agent 设置上云 service.
 *
 * 家长后台改 → server 存 JSONB → push settings_update / hello_ack 携带
 * → Agent merge 写本地 settings.json (保留本地敏感字段).
 *
 * DEFAULT_SETTINGS: 字段白名单 + 默认值; PUT 时仅这些 key 可写, 防止
 *  注入 pin_hash 等敏感字段。
 */
import { pool } from "../db.js";

export interface ChildSettings {
  // 闲置自动 Lock 分钟数 (CLAUDE.md §10.2)
  idle_lock_minutes?: number;

  // 扣分基础: 每 N 秒 tick 一次, ratio token / 分钟
  billing_tick_seconds?: number;
  token_to_minute_ratio?: number;

  // 每日上限 (决策 #35: 0 = 不限)
  daily_hard_cap_minutes?: number;

  // 配额档位 overrides
  weekday_base_tokens?: number;
  weekend_base_tokens?: number;
  daily_credit_cap?: number;
  high_consumption_rate?: number;

  // 低水位预警阈值 (决策: ≤10 提醒)
  low_balance_warn_threshold?: number;

  // UI 行为
  overlay_enabled?: boolean;
  warning_dialog_auto_close_seconds?: number;
  monitor_scan_interval_seconds?: number;

  // 防刷 (决策 #37 默认禁)
  jiggler_detector_enabled?: boolean;
  jiggler_box_threshold_px?: number;

  // 自定义文案
  messages?: Record<string, string>;

  // 申请游戏时间的快捷选项 (不会打字的孩子直接点选)
  // RequestDialog 在输入框上方渲染按钮 chip; 点 → 填进输入框 (允许再改)
  request_quick_options?: string[];
}

/** 字段白名单 + 默认值. PUT 时仅这些 key 可写 (防注入 pin_hash 等). */
export const DEFAULT_SETTINGS: Required<
  Omit<ChildSettings, "messages" | "request_quick_options">
> & {
  messages: Record<string, string>;
  request_quick_options: string[];
} = {
  idle_lock_minutes: 10,
  billing_tick_seconds: 60,
  token_to_minute_ratio: 1.0,
  daily_hard_cap_minutes: 0,
  weekday_base_tokens: 30,
  weekend_base_tokens: 90,
  daily_credit_cap: 120,
  high_consumption_rate: 1.5,
  low_balance_warn_threshold: 10,
  overlay_enabled: true,
  warning_dialog_auto_close_seconds: 0,
  monitor_scan_interval_seconds: 2,
  jiggler_detector_enabled: false,
  jiggler_box_threshold_px: 80,
  messages: {},
  // 不会打字也能申请: 5 条覆盖最常见场景
  request_quick_options: [
    "作业写完了, 想玩 30 分钟",
    "想看一集动画片",
    "想玩 30 分钟游戏",
    "想跟朋友联机玩",
    "想休息一下放松",
  ],
};

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

// 30s 内存 cache (减少 DB 查; 改完后 invalidateCache 即时失效)
const _cache = new Map<string, { value: ChildSettings; expires_at: number }>();
const CACHE_TTL_MS = 30_000;

export function invalidateCache(child_id: string): void {
  _cache.delete(child_id);
}

/** 返回单 child 的 settings (merge 默认值; 直接拿就能用). */
export async function getMergedSettings(child_id: string): Promise<ChildSettings> {
  const cached = _cache.get(child_id);
  if (cached && cached.expires_at > Date.now()) return cached.value;
  const r = await pool.query<{ settings: ChildSettings }>(
    `SELECT settings FROM "NinoGame".child_settings WHERE child_id = $1`,
    [child_id],
  );
  const stored = r.rows[0]?.settings ?? {};
  const merged = mergeWithDefaults(stored);
  _cache.set(child_id, { value: merged, expires_at: Date.now() + CACHE_TTL_MS });
  return merged;
}

/** 单独存的原始 settings (不 merge 默认), 给前端 PUT 后回显用. */
export async function getRawSettings(child_id: string): Promise<ChildSettings> {
  const r = await pool.query<{ settings: ChildSettings }>(
    `SELECT settings FROM "NinoGame".child_settings WHERE child_id = $1`,
    [child_id],
  );
  return r.rows[0]?.settings ?? {};
}

/** partial 更新, 仅白名单 key. 返回写入后的 merged settings + raw settings. */
export async function saveSettings(
  child_id: string,
  partial: Partial<ChildSettings>,
): Promise<{ merged: ChildSettings; raw: ChildSettings }> {
  // 过滤白名单 + 类型轻校验
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    sanitized[k] = v;
  }
  const existing = await getRawSettings(child_id);
  const next = { ...existing, ...sanitized } as ChildSettings;
  await pool.query(
    `INSERT INTO "NinoGame".child_settings (child_id, settings, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (child_id) DO UPDATE SET
       settings = EXCLUDED.settings, updated_at = NOW()`,
    [child_id, JSON.stringify(next)],
  );
  invalidateCache(child_id);
  return {
    merged: mergeWithDefaults(next),
    raw: next,
  };
}

function mergeWithDefaults(stored: ChildSettings): ChildSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(stored)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (k === "messages" && typeof v === "object" && v !== null) {
      out.messages = { ...DEFAULT_SETTINGS.messages, ...(v as Record<string, string>) };
    } else if (k === "request_quick_options") {
      // 数组: stored 整段覆盖 default; null/非数组 fall back default
      if (Array.isArray(v)) {
        out.request_quick_options = v.filter(
          (x): x is string => typeof x === "string" && x.trim().length > 0,
        );
      }
    } else if (v !== null && v !== undefined) {
      out[k] = v;
    }
  }
  return out as ChildSettings;
}
