import { useEffect, useState } from "react";
import { Check, Loader2, RotateCcw, Settings, Sliders } from "lucide-react";
import {
  api,
  ApiError,
  type Child,
  type ChildSettingsForm,
} from "../lib/api";

/** 分组定义: 决定字段在 UI 里出现在哪个分区 */
const NUMBER_FIELDS: Array<{
  key: keyof ChildSettingsForm;
  label: string;
  hint?: string;
  group: "扣分" | "上限" | "提醒" | "UI" | "防刷";
  min?: number;
  max?: number;
  step?: number;
}> = [
  { key: "token_to_minute_ratio", label: "扣分费率 (token/分钟)", group: "扣分", min: 0.1, max: 10, step: 0.1, hint: "每分钟扣多少 token; 默认 1.0" },
  { key: "billing_tick_seconds", label: "扣分周期 (秒)", group: "扣分", min: 10, max: 600, hint: "多久 tick 一次; 默认 60. 改后需重启 Agent" },
  { key: "idle_lock_minutes", label: "闲置 Lock 分钟", group: "扣分", min: 1, max: 60, hint: "孩子离开 N 分钟自动 Lock 停扣; 默认 10" },
  { key: "daily_hard_cap_minutes", label: "每日硬上限 (分钟)", group: "上限", min: 0, max: 720, hint: "0 = 不限. 用满后停扣; 不 kill 进程" },
  { key: "daily_credit_cap", label: "每日发放上限 (token)", group: "上限", min: 0, max: 500, hint: "每天 Path 1 自动挣分上限; 当前 Path 1 已下线但字段保留" },
  { key: "weekday_base_tokens", label: "工作日基础 token", group: "上限", min: 0, max: 500, hint: "每天默认发放" },
  { key: "weekend_base_tokens", label: "周末基础 token", group: "上限", min: 0, max: 500 },
  { key: "high_consumption_rate", label: "高消耗费率系数", group: "扣分", min: 0.1, max: 5, step: 0.1, hint: "当前不参与扣分决策 (决策 #33), 保留字段" },
  { key: "low_balance_warn_threshold", label: "低水位预警 (token)", group: "提醒", min: 0, max: 100, hint: "余额 ≤ 此值时弹一次温和通知" },
  { key: "warning_dialog_auto_close_seconds", label: "通知弹窗自动关秒", group: "UI", min: 0, max: 60, hint: "0 = 不自动关, 必须点确认" },
  { key: "monitor_scan_interval_seconds", label: "进程扫描周期 (秒)", group: "UI", min: 1, max: 30, hint: "默认 2; 老电脑可调到 5 节流" },
  { key: "jiggler_box_threshold_px", label: "鼠标抖动器 box 阈值 (px)", group: "防刷", min: 10, max: 500, hint: "决策 #37 后默认禁用" },
];

const BOOL_FIELDS: Array<{ key: keyof ChildSettingsForm; label: string; hint?: string }> = [
  { key: "overlay_enabled", label: "右上角浮层显示", hint: "Token 余额浮层; 关掉孩子看不到余额" },
  { key: "jiggler_detector_enabled", label: "启用鼠标抖动器检测", hint: "决策 #37 默认禁; 误报率高" },
];

const MESSAGE_KEYS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "block_rule_default", label: "拦截默认文案", placeholder: "这个应用还没被授权使用..." },
  { key: "block_daily_cap", label: "硬上限达到文案", placeholder: "今天的游戏时间已经用完啦..." },
  { key: "block_out_of_balance", label: "余额不足文案", placeholder: "Token 余额不够..." },
];

export default function ChildSettings() {
  const [children, setChildren] = useState<Child[]>([]);
  const [activeChild, setActiveChild] = useState<string>("");
  const [form, setForm] = useState<ChildSettingsForm | null>(null);
  const [raw, setRaw] = useState<Partial<ChildSettingsForm>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.listChildren();
        setChildren(c.children);
        if (c.children.length > 0) setActiveChild(c.children[0].id);
        else setLoading(false);
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : "加载孩子失败");
        setLoading(false);
      }
    })();
  }, []);

  async function load() {
    if (!activeChild) return;
    setLoading(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.getChildSettings(activeChild);
      setForm(r.merged);
      setRaw(r.raw);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载设置失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [activeChild]);

  function patch<K extends keyof ChildSettingsForm>(k: K, v: ChildSettingsForm[K]) {
    setForm((prev) => (prev ? { ...prev, [k]: v } : prev));
  }
  function patchMessage(k: string, v: string) {
    setForm((prev) =>
      prev ? { ...prev, messages: { ...prev.messages, [k]: v } } : prev,
    );
  }

  async function save() {
    if (!form || !activeChild) return;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.saveChildSettings(activeChild, form);
      setForm(r.merged);
      setRaw(r.raw);
      setMsg(`✓ 已保存${r.pushed > 0 ? ` (推送到 ${r.pushed} 台在线 Agent)` : " (Agent 离线, 上线时拉)"}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!confirm("把所有设置恢复默认? Agent 立即同步.")) return;
    setSaving(true);
    try {
      const r = await api.resetChildSettings(activeChild);
      setForm(r.merged);
      setRaw({});
      setMsg(`✓ 已重置 (推送到 ${r.pushed} 台 Agent)`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "重置失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <Settings size={22} className="text-brand" />
          孩子端设置
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          扣分参数 / 上限 / 提醒 / UI / 文案 全部云管。改完即时推送到孩子电脑的 Agent (在线时), 离线时下次上线自动拉。
        </p>
      </div>

      {/* 孩子选择 */}
      <div className="flex gap-3 flex-wrap items-center">
        <select
          className="input max-w-xs"
          value={activeChild}
          onChange={(e) => setActiveChild(e.target.value)}
        >
          {children.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name || c.username}
            </option>
          ))}
        </select>
        <button onClick={load} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          重新加载
        </button>
        <button onClick={reset} className="btn-ghost text-warn" disabled={saving || !form}>
          全部重置默认
        </button>
        <div className="flex-1" />
        <button onClick={save} className="btn-primary" disabled={saving || !form}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {saving ? "保存中..." : "保存"}
        </button>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}
      {msg && <div className="card p-4 text-accent-600 bg-accent/5 border-accent/30">{msg}</div>}

      {form && (
        <>
          {/* 分组渲染数值字段 */}
          {(["扣分", "上限", "提醒", "UI", "防刷"] as const).map((group) => {
            const fields = NUMBER_FIELDS.filter((f) => f.group === group);
            if (fields.length === 0) return null;
            return (
              <section key={group}>
                <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Sliders size={14} className="text-brand" />
                  {group}
                </h2>
                <div className="card p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {fields.map((f) => (
                    <div key={f.key}>
                      <label className="label flex items-center gap-1">
                        {f.label}
                        {f.key in raw && (
                          <span className="badge badge-info ml-1">已改</span>
                        )}
                      </label>
                      <input
                        type="number"
                        className="input"
                        value={String(form[f.key] as number)}
                        onChange={(e) => patch(f.key, Number(e.target.value) as ChildSettingsForm[typeof f.key])}
                        min={f.min}
                        max={f.max}
                        step={f.step ?? 1}
                      />
                      {f.hint && <p className="text-xs text-ink-light mt-1">{f.hint}</p>}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {/* 开关字段 */}
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
              开关
            </h2>
            <div className="card p-5 space-y-3">
              {BOOL_FIELDS.map((f) => (
                <div key={f.key} className="flex items-start gap-3">
                  <input
                    id={f.key}
                    type="checkbox"
                    checked={Boolean(form[f.key])}
                    onChange={(e) => patch(f.key, e.target.checked as ChildSettingsForm[typeof f.key])}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <label htmlFor={f.key} className="text-sm font-medium text-ink cursor-pointer">
                      {f.label}
                      {f.key in raw && <span className="badge badge-info ml-2">已改</span>}
                    </label>
                    {f.hint && <p className="text-xs text-ink-light mt-0.5">{f.hint}</p>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 文案 */}
          <section>
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-3">
              文案 (孩子端弹窗看到)
            </h2>
            <div className="card p-5 space-y-4">
              {MESSAGE_KEYS.map((m) => (
                <div key={m.key}>
                  <label className="label">{m.label}</label>
                  <textarea
                    className="input min-h-[60px]"
                    value={form.messages[m.key] || ""}
                    onChange={(e) => patchMessage(m.key, e.target.value)}
                    placeholder={m.placeholder}
                  />
                </div>
              ))}
              <p className="text-xs text-ink-light">
                留空 → Agent 端使用本地默认文案。支持占位符: <code>{"{balance}"}</code> <code>{"{cost}"}</code> <code>{"{used_minutes}"}</code> 等
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
