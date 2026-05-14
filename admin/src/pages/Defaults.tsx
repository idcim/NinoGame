import { useEffect, useState } from "react";
import { Loader2, Plus, Sliders, Trash2 } from "lucide-react";
import { api, ApiError, type AdminDefaults, type RuleSeed } from "../lib/api";

export default function Defaults() {
  const [defaults, setDefaults] = useState<AdminDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { const r = await api.getDefaults(); setDefaults(r.defaults); }
      catch (e) { setErr(e instanceof ApiError ? e.message : "加载失败"); }
      finally { setLoading(false); }
    })();
  }, []);

  async function save() {
    if (!defaults) return;
    setErr(null); setMsg(null);
    try {
      await api.saveDefaults(defaults);
      setMsg("✓ 已保存. 新建 child 时生效.");
    } catch (e) { setErr(e instanceof ApiError ? e.message : "保存失败"); }
  }

  function addRule() {
    if (!defaults) return;
    setDefaults({
      ...defaults,
      default_rules: [
        ...defaults.default_rules,
        { name: "新规则", keywords: [""], action: "kill_and_warn", message: "" },
      ],
    });
  }
  function patchRule(i: number, patch: Partial<RuleSeed>) {
    if (!defaults) return;
    setDefaults({
      ...defaults,
      default_rules: defaults.default_rules.map((r, idx) => idx === i ? { ...r, ...patch } : r),
    });
  }
  function delRule(i: number) {
    if (!defaults) return;
    setDefaults({
      ...defaults,
      default_rules: defaults.default_rules.filter((_, idx) => idx !== i),
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <Sliders size={22} className="text-brand" />
          默认值
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          新建 child 时使用的默认配置 + 默认拦截规则。现有 child 不受影响。
        </p>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}
      {msg && <div className="card p-4 text-accent-600 bg-accent/5 border-accent/30">{msg}</div>}
      {loading || !defaults ? (
        <div className="card p-8 text-center text-ink-dim">
          <Loader2 size={20} className="animate-spin mx-auto mb-2" />加载中…
        </div>
      ) : (
        <>
          <div className="card p-5 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">默认成熟度档位</label>
                <select className="input" value={defaults.maturity_mode}
                  onChange={(e) => setDefaults({ ...defaults, maturity_mode: e.target.value as AdminDefaults["maturity_mode"] })}>
                  <option value="strict">strict — 严管</option>
                  <option value="negotiable">negotiable — 协商 (默认)</option>
                  <option value="advisory">advisory — 软干预</option>
                  <option value="self_regulated">self_regulated — 自管理</option>
                </select>
              </div>
              <div>
                <label className="label">默认配额档位</label>
                <select className="input" value={defaults.quota_package}
                  onChange={(e) => setDefaults({ ...defaults, quota_package: e.target.value as AdminDefaults["quota_package"] })}>
                  <option value="tight">tight — 严守</option>
                  <option value="balanced">balanced — 平衡 (默认)</option>
                  <option value="task_driven">task_driven — 任务驱动</option>
                  <option value="trust">trust — 信任</option>
                  <option value="custom">custom — 自定义</option>
                </select>
              </div>
            </div>
          </div>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-ink uppercase tracking-wide">
                默认规则 seed ({defaults.default_rules.length})
              </h2>
              <button onClick={addRule} className="btn-ghost text-xs">
                <Plus size={12} />新增规则
              </button>
            </div>
            <div className="space-y-2">
              {defaults.default_rules.map((r, i) => (
                <div key={i} className="card p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input className="input flex-1" value={r.name}
                      onChange={(e) => patchRule(i, { name: e.target.value })}
                      placeholder="规则名 (例: 原神)" />
                    <select className="input max-w-[160px]" value={r.action}
                      onChange={(e) => patchRule(i, { action: e.target.value as RuleSeed["action"] })}>
                      <option value="kill_and_warn">杀+提示</option>
                      <option value="warn_only">仅提示</option>
                      <option value="kill_silent">悄悄杀</option>
                    </select>
                    <button onClick={() => delRule(i)} className="p-2 text-ink-dim hover:text-warn">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <textarea className="input font-mono text-xs min-h-[48px]"
                    value={r.keywords.join(", ")}
                    onChange={(e) => patchRule(i, { keywords: e.target.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) })}
                    placeholder="关键词 (逗号分隔), 中英文别名" />
                  <input className="input" value={r.message}
                    onChange={(e) => patchRule(i, { message: e.target.value })}
                    placeholder="弹窗提示文案 (可空)" />
                </div>
              ))}
            </div>
          </section>

          <div className="flex justify-end">
            <button onClick={save} className="btn-primary">保存</button>
          </div>
        </>
      )}
    </div>
  );
}
