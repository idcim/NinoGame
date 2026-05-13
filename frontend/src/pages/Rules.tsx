import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  Check,
  Edit3,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError, type Child, type Matcher, type Rule, type RuleSpec } from "../lib/api";

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

  const [editing, setEditing] = useState<Rule | "new" | null>(null);

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
          rule={editing === "new" ? null : editing}
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
      <span className="badge badge-warn">硬拦</span>
    ) : rule.spec.action.type === "warn_only" ? (
      <span className="badge badge-info">仅警告</span>
    ) : (
      <span className="badge badge-muted">静默杀</span>
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
          {rule.spec.matchers.length} 个 matcher · {totalKeywords} 个关键词 · {rule.spec.matcher_logic}
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
  childId,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  childId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = rule === null;
  const [name, setName] = useState(rule?.name || "");
  const [keywords, setKeywords] = useState(
    rule
      ? Array.from(
          new Set(rule.spec.matchers.map((m) => m.value.toLowerCase())),
        ).join(", ")
      : "",
  );
  const [actionType, setActionType] = useState<RuleSpec["action"]["type"]>(
    rule?.spec.action.type || "kill_and_warn",
  );
  const [message, setMessage] = useState(rule?.spec.action.message || "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    const spec: RuleSpec = {
      matchers,
      matcher_logic: "OR",
      exclude_processes: [],
      schedule: { mode: "always", windows: [] },
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
                <option value="kill_and_warn">硬拦 (kill + 弹窗)</option>
                <option value="warn_only">仅警告</option>
                <option value="kill_silent">静默杀</option>
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
