import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  Check,
  Clock,
  Edit3,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  type Child,
  type Matcher,
  type Rule,
  type RuleDraft,
  type RuleSpec,
} from "../lib/api";
import { actionLabel } from "../lib/labels";

// 时间窗类型 (CLAUDE.md §9.1 schedule.windows): days 用 JS 习惯
// 0=周日..6=周六 (与前端 Date.getDay 一致), agent 端 Python 做换算。
type Window = { days: number[]; from: string; to: string };
type ScheduleMode = "always" | "windowed" | "disabled";

const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];

function describeSchedule(s: RuleSpec["schedule"]): string {
  const mode = s.mode as ScheduleMode;
  if (mode === "disabled") return "已暂停";
  if (mode === "always") return "始终生效";
  const ws = (s.windows as Window[]) || [];
  if (ws.length === 0) return "始终生效 (无窗口)";
  if (ws.length === 1) {
    const w = ws[0];
    return `${describeDays(w.days)} ${w.from}-${w.to}`;
  }
  return `${ws.length} 段时段`;
}

function describeDays(days: number[]): string {
  if (days.length === 0) return "每天";
  if (days.length === 7) return "每天";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 5 && sorted.every((d, i) => d === WEEKDAYS[i])) return "工作日";
  if (sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6) return "周末";
  return sorted.map((d) => DAY_LABELS[d]).join("");
}

export default function Rules() {
  const [children, setChildren] = useState<Child[]>([]);
  const [activeChild, setActiveChild] = useState<string>("");
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 初始: 拉孩子列表 + 默认选第一个
  useEffect(() => {
    (async () => {
      try {
        const c = await api.listChildren();
        setChildren(c.children);
        if (c.children.length > 0) {
          setActiveChild(c.children[0].id);
        } else {
          setLoading(false);
        }
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : "加载孩子失败");
        setLoading(false);
      }
    })();
  }, []);

  // 每次 activeChild 变 → 拉规则
  useEffect(() => {
    if (!activeChild) return;
    loadRules();
  }, [activeChild]);

  async function loadRules() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listRules(activeChild);
      setRules(r.rules);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载规则失败");
    } finally {
      setLoading(false);
    }
  }

  // editing: Rule = 编辑已有, "new" = 空白新建, RuleDraft = LLM 草稿预填新建
  const [editing, setEditing] = useState<Rule | "new" | RuleDraft | null>(null);

  // LLM 一句话生成
  const [llmText, setLlmText] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmHint, setLlmHint] = useState<string | null>(null);

  async function generateFromText() {
    if (!llmText.trim() || !activeChild) return;
    setLlmBusy(true);
    setLlmHint(null);
    try {
      const { draft } = await api.draftRuleFromText(activeChild, llmText.trim());
      setEditing(draft);
      setLlmText("");
      if (draft.reasoning) setLlmHint(`LLM: ${draft.reasoning}`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "生成失败";
      setLlmHint(msg);
    } finally {
      setLlmBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <Shield size={22} className="text-brand" />
            规则
          </h1>
          <p className="text-sm text-ink-dim mt-1">
            添加新游戏关键词 → 保存即生效 → Agent 立即更新本地 rules.json
          </p>
        </div>
        <button onClick={loadRules} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      {/* 孩子选择 */}
      {children.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {children.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveChild(c.id)}
              className={
                "px-4 py-1.5 rounded-full text-sm transition-colors " +
                (c.id === activeChild
                  ? "bg-brand text-white"
                  : "bg-bg-card border border-border text-ink-dim hover:text-ink")
              }
            >
              {c.display_name || c.username}
            </button>
          ))}
        </div>
      )}

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      {children.length === 0 && !loading ? (
        <div className="card p-8 text-center text-ink-dim">
          还没有孩子。先去 <a className="text-brand" href="/">概览</a> 创建。
        </div>
      ) : (
        <>
          {/* LLM 一句话生成 */}
          <div className="card p-4 bg-brand/5 border-brand/30">
            <div className="flex items-center gap-1.5 mb-2 text-sm font-semibold text-brand">
              <Sparkles size={14} />
              一句话生成规则
            </div>
            <div className="flex gap-2 flex-wrap sm:flex-nowrap">
              <input
                className="input flex-1 min-w-0"
                value={llmText}
                onChange={(e) => setLlmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !llmBusy) {
                    e.preventDefault();
                    generateFromText();
                  }
                }}
                disabled={llmBusy || !activeChild}
                placeholder="例: 禁止玩原神 / 晚上 9 点后不让玩王者荣耀 / 工作日不能玩 Minecraft"
                maxLength={500}
              />
              <button
                type="button"
                onClick={generateFromText}
                disabled={llmBusy || !llmText.trim() || !activeChild}
                className="btn-primary shrink-0"
              >
                {llmBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                生成
              </button>
            </div>
            {llmHint && (
              <div className="text-xs text-ink-dim mt-2">{llmHint}</div>
            )}
            <p className="text-xs text-ink-light mt-1">
              生成完会打开编辑器, 关键词/动作/时段都可以再改, 点保存才真正生效。
              没配置 LLM? 去 <a className="text-brand underline" href="/llm-config">LLM 配置</a>。
            </p>
          </div>

          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wide">
              当前规则 ({rules.length})
            </h2>
            <button
              onClick={() => setEditing("new")}
              className="btn-primary"
              disabled={!activeChild}
            >
              <Plus size={14} />
              新增规则
            </button>
          </div>

          <div className="space-y-2">
            {rules.length === 0 && !loading && (
              <div className="card p-8 text-center text-ink-dim">
                还没有规则。点「新增规则」加一个游戏。
              </div>
            )}
            {rules.map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                onEdit={() => setEditing(r)}
                onChanged={loadRules}
              />
            ))}
          </div>
        </>
      )}

      {editing && (
        <RuleEditor
          rule={editing === "new" || isDraft(editing) ? null : editing}
          draft={isDraft(editing) ? editing : null}
          childId={activeChild}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadRules();
          }}
        />
      )}
    </div>
  );
}

function isDraft(x: Rule | "new" | RuleDraft): x is RuleDraft {
  return typeof x === "object" && x !== null && "keywords" in x && Array.isArray((x as RuleDraft).keywords);
}

function RuleRow({
  rule,
  onEdit,
  onChanged,
}: {
  rule: Rule;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const totalKeywords = useMemo(() => {
    const vals = new Set(rule.spec.matchers.map((m) => m.value.toLowerCase()));
    return vals.size;
  }, [rule]);

  async function toggleEnabled() {
    setBusy(true);
    try {
      await api.updateRule(rule.id, { enabled: !rule.enabled });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm(`删除规则「${rule.name}」?`)) return;
    setBusy(true);
    try {
      await api.deleteRule(rule.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const actionBadge =
    rule.spec.action.type === "kill_and_warn" ? (
      <span className="badge badge-warn">{actionLabel(rule.spec.action.type)}</span>
    ) : rule.spec.action.type === "warn_only" ? (
      <span className="badge badge-info">{actionLabel(rule.spec.action.type)}</span>
    ) : (
      <span className="badge badge-muted">{actionLabel(rule.spec.action.type)}</span>
    );

  return (
    <div className="card p-4 flex items-center gap-3">
      <div
        className={
          "w-10 h-10 rounded-lg flex items-center justify-center shrink-0 " +
          (rule.enabled ? "bg-warn/10 text-warn" : "bg-ink-light/10 text-ink-dim")
        }
      >
        <Ban size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold">{rule.name}</span>
          {actionBadge}
          {!rule.enabled && <span className="badge badge-muted">已禁用</span>}
        </div>
        <div className="text-xs text-ink-dim mt-0.5 truncate">
          {rule.spec.matchers.length} 个 matcher · {totalKeywords} 个关键词 ·{" "}
          <Clock size={10} className="inline -mt-0.5" /> {describeSchedule(rule.spec.schedule)}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={toggleEnabled}
          disabled={busy}
          className="text-xs px-2 py-1 rounded text-ink-dim hover:text-brand"
          title={rule.enabled ? "禁用" : "启用"}
        >
          {rule.enabled ? "禁用" : "启用"}
        </button>
        <button
          onClick={onEdit}
          className="p-2 rounded text-ink-dim hover:text-brand"
          title="编辑"
        >
          <Edit3 size={14} />
        </button>
        <button
          onClick={del}
          disabled={busy}
          className="p-2 rounded text-ink-dim hover:text-warn"
          title="删除"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  draft,
  childId,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  draft?: RuleDraft | null;
  childId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = rule === null;
  const [name, setName] = useState(rule?.name || draft?.name || "");
  const [keywords, setKeywords] = useState(
    rule
      ? Array.from(
          new Set(rule.spec.matchers.map((m) => m.value.toLowerCase())),
        ).join(", ")
      : draft
      ? draft.keywords.join(", ")
      : "",
  );
  const [actionType, setActionType] = useState<RuleSpec["action"]["type"]>(
    rule?.spec.action.type || draft?.action || "kill_and_warn",
  );
  const [message, setMessage] = useState(
    rule?.spec.action.message || draft?.message || "",
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    (rule?.spec.schedule.mode as ScheduleMode) || draft?.schedule.mode || "always",
  );
  const [windows, setWindows] = useState<Window[]>(
    (rule?.spec.schedule.windows as Window[]) ||
      (draft?.schedule.windows as Window[]) ||
      [],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function addWindow() {
    setWindows((ws) => [...ws, { days: [...WEEKDAYS], from: "21:00", to: "23:00" }]);
  }
  function removeWindow(i: number) {
    setWindows((ws) => ws.filter((_, idx) => idx !== i));
  }
  function updateWindow(i: number, patch: Partial<Window>) {
    setWindows((ws) => ws.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  }
  function toggleDay(i: number, day: number) {
    setWindows((ws) =>
      ws.map((w, idx) =>
        idx === i
          ? {
              ...w,
              days: w.days.includes(day)
                ? w.days.filter((d) => d !== day)
                : [...w.days, day].sort((a, b) => a - b),
            }
          : w,
      ),
    );
  }

  function buildMatchers(): Matcher[] {
    const kws = keywords
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out: Matcher[] = [];
    for (const kw of kws) {
      out.push({ field: "process_name", op: "icontains", value: kw });
      out.push({ field: "window_title", op: "icontains", value: kw });
    }
    return out;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const matchers = buildMatchers();
    if (matchers.length === 0) {
      setErr("至少输入一个关键词");
      return;
    }
    // 校验时间窗
    if (scheduleMode === "windowed") {
      for (const w of windows) {
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(w.from) || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(w.to)) {
          setErr("时段格式必须是 HH:MM (如 21:00)");
          return;
        }
        if (w.from === w.to) {
          setErr("起止时间不能相同");
          return;
        }
      }
    }
    const spec: RuleSpec = {
      matchers,
      matcher_logic: "OR",
      exclude_processes: [],
      schedule: {
        mode: scheduleMode,
        windows: scheduleMode === "windowed" ? windows : [],
      },
      action: { type: actionType, message },
      notify_parent: true,
    };
    setBusy(true);
    try {
      if (isNew) {
        await api.createRule({ child_id: childId, name, enabled, spec });
      } else {
        await api.updateRule(rule!.id, { name, enabled, spec });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="card p-6 w-full max-w-lg max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg flex items-center gap-2">
            <Shield size={18} className="text-brand" />
            {isNew ? "新增规则" : "编辑规则"}
          </h3>
          <button onClick={onClose} className="text-ink-dim hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">规则名 (展示用)</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={1}
              maxLength={128}
              placeholder="例: 原神"
              autoFocus
            />
          </div>

          <div>
            <label className="label">关键词 (逗号分隔; 任一命中即生效)</label>
            <textarea
              className="input min-h-[64px] font-mono text-sm"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="例: 原神, genshin, yuanshen"
              required
            />
            <p className="text-xs text-ink-light mt-1">
              每个关键词自动生成 2 个 matcher (进程名 + 窗口标题, icontains)。
              想精细控制 matchers 后续会加高级编辑器。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">动作</label>
              <select
                className="input"
                value={actionType}
                onChange={(e) => setActionType(e.target.value as RuleSpec["action"]["type"])}
              >
                <option value="kill_and_warn">直接拦截 (杀进程 + 弹窗)</option>
                <option value="warn_only">只提示 (不杀)</option>
                <option value="kill_silent">悄悄拦截 (杀进程不弹窗)</option>
              </select>
            </div>
            <div>
              <label className="label">启用状态</label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={
                  "input flex items-center gap-2 justify-center " +
                  (enabled
                    ? "border-accent text-accent-600 bg-accent/5"
                    : "border-ink-light text-ink-dim")
                }
              >
                {enabled ? <Check size={14} /> : <X size={14} />}
                {enabled ? "已启用" : "已禁用"}
              </button>
            </div>
          </div>

          <div>
            <label className="label">提示文案 (孩子端弹窗看到)</label>
            <input
              className="input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={512}
              placeholder="留空用全局默认; 例: 原神还没被授权使用, 先和家长沟通"
            />
          </div>

          <div className="border-t border-border pt-4">
            <label className="label flex items-center gap-1.5">
              <Clock size={14} className="text-brand" />
              生效时段
            </label>
            <select
              className="input"
              value={scheduleMode}
              onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
            >
              <option value="always">始终生效 (24/7)</option>
              <option value="windowed">仅指定时段</option>
              <option value="disabled">暂停 (规则保留但不拦截)</option>
            </select>
            <p className="text-xs text-ink-light mt-1">
              "仅指定时段": 可加多段窗口, 每段选星期 + 起止时间; 任一窗口命中即拦截。
              起止跨午夜 (例如 21:00→02:00) 支持。
            </p>

            {scheduleMode === "windowed" && (
              <div className="mt-3 space-y-3">
                {windows.length === 0 && (
                  <p className="text-xs text-ink-dim">
                    没有时段时, 该规则会保守视为 "始终生效"。点下面按钮添加第一段。
                  </p>
                )}
                {windows.map((w, i) => (
                  <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-ink-dim">
                        时段 #{i + 1} · {describeDays(w.days)} {w.from}-{w.to}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeWindow(i)}
                        className="text-xs text-ink-dim hover:text-warn"
                        title="删除该时段"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {DAY_LABELS.map((lbl, d) => {
                        const on = w.days.includes(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => toggleDay(i, d)}
                            className={
                              "w-7 h-7 rounded-md text-xs font-medium border " +
                              (on
                                ? "bg-brand text-white border-brand"
                                : "bg-transparent text-ink-dim border-border hover:border-brand")
                            }
                          >
                            {lbl}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => updateWindow(i, { days: [...WEEKDAYS] })}
                        className="text-xs px-2 rounded text-ink-dim hover:text-brand"
                      >
                        工作日
                      </button>
                      <button
                        type="button"
                        onClick={() => updateWindow(i, { days: [...WEEKENDS] })}
                        className="text-xs px-2 rounded text-ink-dim hover:text-brand"
                      >
                        周末
                      </button>
                      <button
                        type="button"
                        onClick={() => updateWindow(i, { days: [0, 1, 2, 3, 4, 5, 6] })}
                        className="text-xs px-2 rounded text-ink-dim hover:text-brand"
                      >
                        每天
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        className="input flex-1"
                        value={w.from}
                        onChange={(e) => updateWindow(i, { from: e.target.value })}
                      />
                      <span className="text-ink-dim">→</span>
                      <input
                        type="time"
                        className="input flex-1"
                        value={w.to}
                        onChange={(e) => updateWindow(i, { to: e.target.value })}
                      />
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addWindow}
                  className="btn-ghost text-xs w-full"
                >
                  <Plus size={12} />
                  添加时段
                </button>
              </div>
            )}
          </div>

          {err && (
            <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
              {err}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="btn-ghost" disabled={busy}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "保存中..." : isNew ? "创建" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
