import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Edit3,
  Gem,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  api,
  ApiError,
  type ResponsibilityCheck,
  type Task,
  type TaskCategory,
  type TaskCompletion,
  type TaskSchedule,
  type TaskVerification,
} from "../lib/api";
import { useChild } from "../lib/childContext";
import {
  taskCategoryLabel,
  taskCompletionStatusLabel,
  taskScheduleLabel,
  taskVerificationLabel,
  timeAgo,
} from "../lib/labels";

type Tab = "templates" | "queue" | "history";

export default function Tasks() {
  const [tab, setTab] = useState<Tab>("queue");
  const { activeChildId, children: childrenList } = useChild();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <ClipboardList size={22} className="text-brand" />
          任务
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          模板 = 家长定义的可挣分项 (§8.3) + 责任清单 (§8.6); 申报队列 = 孩子点击「我做完了」后等家长审批
        </p>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-2 flex-wrap">
          {(["queue", "templates", "history"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "px-4 py-1.5 rounded-full text-sm transition-colors " +
                (t === tab
                  ? "bg-brand text-white"
                  : "bg-bg-card border border-border text-ink-dim hover:text-ink")
              }
            >
              {t === "queue" ? "申报队列" : t === "templates" ? "任务模板" : "责任清单历史"}
            </button>
          ))}
        </div>
      </div>

      {childrenList.length === 0 ? (
        <div className="card p-8 text-center text-ink-dim">
          还没有孩子。先去 <a className="text-brand" href="/">概览</a> 创建。
        </div>
      ) : tab === "queue" ? (
        <CompletionQueue />
      ) : tab === "templates" ? (
        <TemplateSection childId={activeChildId} />
      ) : (
        <ResponsibilityHistory childId={activeChildId} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// 申报队列
// ────────────────────────────────────────────────────────────────
function CompletionQueue() {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected" | "all">(
    "pending",
  );
  const [items, setItems] = useState<TaskCompletion[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listTaskCompletions(status);
      setItems(r.completions);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5 flex-wrap">
          {(["pending", "approved", "rejected", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={
                "text-xs px-3 py-1 rounded-full transition-colors " +
                (s === status
                  ? "bg-brand-50 text-brand-600 border border-brand"
                  : "bg-bg-card border border-border text-ink-dim hover:text-ink")
              }
            >
              {taskCompletionStatusLabel(s)}
              {s === "all" ? "" : ""}
              {s === "all" && " (全部)"}
            </button>
          ))}
        </div>
        <button onClick={load} className="btn-ghost text-sm" disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          刷新
        </button>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      <div className="space-y-2">
        {items.length === 0 && !loading && (
          <div className="card p-8 text-center text-ink-dim">
            没有{taskCompletionStatusLabel(status)}的申报
          </div>
        )}
        {items.map((c) => (
          <CompletionRow key={c.id} item={c} onChanged={load} />
        ))}
      </div>
    </section>
  );
}

function CompletionRow({
  item, onChanged,
}: { item: TaskCompletion; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const isPending = item.status === "pending";
  const reward = item.reward_granted ?? item.reward_tokens ?? 0;

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div
          className={
            "w-9 h-9 rounded-full flex items-center justify-center shrink-0 " +
            (item.status === "approved"
              ? "bg-accent/15 text-accent-600"
              : item.status === "rejected"
                ? "bg-warn/15 text-warn"
                : "bg-brand-50 text-brand-600")
          }
        >
          {item.status === "approved" ? (
            <CheckCircle2 size={16} />
          ) : item.status === "rejected" ? (
            <XCircle size={16} />
          ) : (
            <Clock size={16} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">
              {item.display_name || item.child_username || "孩子"}
            </span>
            <span className="text-ink-dim text-sm">完成了</span>
            <span className="font-medium text-brand">{item.task_name || item.task_id}</span>
            <span
              className={
                "badge " +
                (item.status === "pending"
                  ? "badge-info"
                  : item.status === "approved"
                    ? "badge-success"
                    : "badge-warn")
              }
            >
              {taskCompletionStatusLabel(item.status)}
            </span>
            <span
              className="text-xs text-ink-light"
              title={new Date(item.created_at).toLocaleString()}
            >
              {timeAgo(item.created_at)}
            </span>
          </div>
          <div className="mt-1 text-xs text-ink-dim flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1">
              <Gem size={12} className="text-brand" />
              {reward > 0 ? `+${reward} token` : "不挣分"}
            </span>
            {item.task_category && <span>{taskCategoryLabel(item.task_category)}</span>}
          </div>
          {item.child_note && (
            <p className="mt-1 text-sm text-ink">备注: {item.child_note}</p>
          )}
          {item.parent_comment && (
            <p className="mt-1 text-xs text-ink-dim">家长意见: {item.parent_comment}</p>
          )}
        </div>
      </div>

      {isPending && (
        <div className="flex gap-2 justify-end mt-2">
          <button
            onClick={async () => {
              const c = prompt("拒绝理由 (可选):") ?? undefined;
              if (c === null) return; // user clicked cancel
              setBusy(true);
              try {
                await api.rejectTaskCompletion(item.id, c || undefined);
                onChanged();
              } catch (e) {
                alert(e instanceof ApiError ? e.message : "失败");
              } finally {
                setBusy(false);
              }
            }}
            className="btn-ghost"
            disabled={busy}
          >
            <X size={14} />
            拒绝
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              try {
                await api.approveTaskCompletion(item.id);
                onChanged();
              } catch (e) {
                alert(e instanceof ApiError ? e.message : "失败");
              } finally {
                setBusy(false);
              }
            }}
            className="btn-primary"
            disabled={busy}
          >
            <Check size={14} />
            批准 +{reward}
          </button>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// 模板 CRUD
// ────────────────────────────────────────────────────────────────
function TemplateSection({ childId }: { childId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | "new" | null>(null);

  async function load() {
    if (!childId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listTasks(childId);
      setTasks(r.tasks);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [childId]);

  const responsibilityTasks = tasks.filter((t) => t.category === "responsibility");
  const incentiveTasks = tasks.filter((t) => t.category === "incentive");

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-dim">
          模板改动会立即推送给在线 Agent (设备上的"今日可做"列表同步更新)
        </span>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn-ghost text-sm" disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            刷新
          </button>
          <button
            onClick={() => setEditing("new")}
            className="btn-primary"
            disabled={!childId}
          >
            <Plus size={14} />
            新建任务
          </button>
        </div>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      <TaskGroup
        title="激励任务 (挣 token)"
        items={incentiveTasks}
        onEdit={(t) => setEditing(t)}
        onChanged={load}
      />
      <TaskGroup
        title="责任清单 (不挣分)"
        items={responsibilityTasks}
        onEdit={(t) => setEditing(t)}
        onChanged={load}
      />

      {editing && (
        <TaskEditor
          task={editing === "new" ? null : editing}
          childId={childId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function TaskGroup({
  title, items, onEdit, onChanged,
}: {
  title: string;
  items: Task[];
  onEdit: (t: Task) => void;
  onChanged: () => void;
}) {
  return (
    <div>
      <h2 className="text-sm font-bold text-ink uppercase tracking-wide mb-2">
        {title} <span className="text-ink-light font-normal">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <div className="card p-4 text-center text-ink-light text-sm">空</div>
      ) : (
        <div className="space-y-2">
          {items.map((t) => (
            <TaskRow key={t.id} task={t} onEdit={() => onEdit(t)} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task, onEdit, onChanged,
}: { task: Task; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function toggleActive() {
    setBusy(true);
    try {
      await api.updateTask(task.id, { active: !task.active });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm(`删除任务「${task.name}」? 会一并删除其所有完成记录。`)) return;
    setBusy(true);
    try {
      await api.deleteTask(task.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 flex items-center gap-3">
      <div
        className={
          "w-10 h-10 rounded-lg flex items-center justify-center shrink-0 " +
          (task.active
            ? task.category === "responsibility"
              ? "bg-accent/10 text-accent-600"
              : "bg-brand-50 text-brand-600"
            : "bg-ink-light/10 text-ink-dim")
        }
      >
        <ClipboardList size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold">{task.name}</span>
          {!task.active && <span className="badge badge-muted">已禁用</span>}
          {task.category === "incentive" && task.reward_tokens > 0 && (
            <span className="badge badge-info">
              <Gem size={10} className="inline" /> +{task.reward_tokens}
            </span>
          )}
        </div>
        <div className="text-xs text-ink-dim mt-0.5">
          {taskCategoryLabel(task.category)} · {taskScheduleLabel(task.schedule)} ·{" "}
          {taskVerificationLabel(task.verification)}
          {task.daily_max_completions > 1 && ` · 每日最多 ${task.daily_max_completions} 次`}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={toggleActive}
          disabled={busy}
          className="text-xs px-2 py-1 rounded text-ink-dim hover:text-brand"
        >
          {task.active ? "禁用" : "启用"}
        </button>
        <button onClick={onEdit} className="p-2 rounded text-ink-dim hover:text-brand">
          <Edit3 size={14} />
        </button>
        <button onClick={del} disabled={busy} className="p-2 rounded text-ink-dim hover:text-warn">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function TaskEditor({
  task, childId, onClose, onSaved,
}: {
  task: Task | null;
  childId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = task === null;
  const [name, setName] = useState(task?.name || "");
  const [category, setCategory] = useState<TaskCategory>(task?.category || "incentive");
  const [reward, setReward] = useState(task?.reward_tokens ?? 30);
  const [schedule, setSchedule] = useState<TaskSchedule>(task?.schedule || "daily");
  const [verification, setVerification] = useState<TaskVerification>(
    task?.verification || "parent_approve",
  );
  const [maxCompletions, setMaxCompletions] = useState(task?.daily_max_completions ?? 1);
  const [active, setActive] = useState(task?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 责任类强制不挣分
  const effectiveReward = category === "responsibility" ? 0 : reward;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (isNew) {
        await api.createTask({
          child_id: childId,
          name,
          category,
          reward_tokens: effectiveReward,
          daily_max_completions: maxCompletions,
          verification,
          schedule,
          active,
        });
      } else {
        await api.updateTask(task!.id, {
          name,
          category,
          reward_tokens: effectiveReward,
          daily_max_completions: maxCompletions,
          verification,
          schedule,
          active,
        });
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
            <ClipboardList size={18} className="text-brand" />
            {isNew ? "新建任务" : "编辑任务"}
          </h3>
          <button onClick={onClose} className="text-ink-dim hover:text-ink">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">任务名</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={1}
              maxLength={128}
              placeholder="例: 完成今日作业 / 整理书桌"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">类别</label>
              <select
                className="input"
                value={category}
                onChange={(e) => setCategory(e.target.value as TaskCategory)}
              >
                <option value="incentive">激励 (挣 token)</option>
                <option value="responsibility">责任清单 (不挣分)</option>
              </select>
            </div>
            <div>
              <label className="label">周期</label>
              <select
                className="input"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value as TaskSchedule)}
              >
                <option value="daily">每日</option>
                <option value="weekly">每周</option>
                <option value="once">一次性</option>
              </select>
            </div>
          </div>

          {category === "incentive" && (
            <>
              <div>
                <label className="label">奖励 token 数</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    className="input flex-1"
                    value={reward}
                    onChange={(e) => setReward(Number(e.target.value || 0))}
                    min={0}
                    max={500}
                    required
                  />
                  <div className="flex gap-1">
                    {[10, 20, 30, 50].map((v) => (
                      <button
                        type="button"
                        key={v}
                        onClick={() => setReward(v)}
                        className={
                          "text-xs px-2 py-1 rounded border " +
                          (reward === v
                            ? "border-brand text-brand-600 bg-brand-50"
                            : "border-border text-ink-dim hover:text-ink")
                        }
                      >
                        +{v}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">验证方式</label>
                  <select
                    className="input"
                    value={verification}
                    onChange={(e) => setVerification(e.target.value as TaskVerification)}
                  >
                    <option value="parent_approve">家长审批</option>
                    <option value="self_report">自报为准</option>
                    <option value="auto">自动检测</option>
                  </select>
                </div>
                <div>
                  <label className="label">每日最多完成</label>
                  <input
                    type="number"
                    className="input"
                    value={maxCompletions}
                    onChange={(e) => setMaxCompletions(Number(e.target.value || 1))}
                    min={1}
                    max={10}
                  />
                </div>
              </div>
            </>
          )}

          {category === "responsibility" && (
            <div className="text-xs text-ink-dim bg-bg-soft rounded px-3 py-2 leading-relaxed">
              责任清单类任务不挣 token (CLAUDE.md §8.6) — 让"做人本分"与"突破基线"分开。
              孩子在 Agent 托盘里勾选, 系统每日给家长一份责任完成率统计。
            </div>
          )}

          <div>
            <label className="label">启用状态</label>
            <button
              type="button"
              onClick={() => setActive(!active)}
              className={
                "input flex items-center gap-2 justify-center " +
                (active
                  ? "border-accent text-accent-600 bg-accent/5"
                  : "border-ink-light text-ink-dim")
              }
            >
              {active ? <Check size={14} /> : <X size={14} />}
              {active ? "已启用" : "已禁用"}
            </button>
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

// ────────────────────────────────────────────────────────────────
// 责任清单历史
// ────────────────────────────────────────────────────────────────
function ResponsibilityHistory({ childId }: { childId: string }) {
  const [days, setDays] = useState(14);
  const [checks, setChecks] = useState<ResponsibilityCheck[]>([]);
  const [tasks, setTasks] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!childId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listResponsibilityChecks(childId, days);
      setChecks(r.checks);
      setTasks(r.responsibility_tasks);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [childId, days]);

  // grouped: date -> task_id -> completed
  const grid = useMemo(() => {
    const m = new Map<string, Map<string, boolean>>();
    for (const c of checks) {
      const date = c.check_date.slice(0, 10);
      if (!m.has(date)) m.set(date, new Map());
      m.get(date)!.set(c.task_id, c.completed);
    }
    return m;
  }, [checks]);

  const dates = useMemo(() => {
    const out: string[] = [];
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, [days]);

  // 完成率: 所有 (task,date) 的总数中 completed=true 的占比
  const rate = useMemo(() => {
    if (tasks.length === 0 || dates.length === 0) return 0;
    let total = 0;
    let done = 0;
    for (const date of dates) {
      for (const t of tasks) {
        total++;
        if (grid.get(date)?.get(t.id) === true) done++;
      }
    }
    return total > 0 ? (done / total) * 100 : 0;
  }, [dates, tasks, grid]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm text-ink-dim">最近</span>
          <select
            className="input w-auto"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>7 天</option>
            <option value={14}>14 天</option>
            <option value={30}>30 天</option>
          </select>
          <span className="text-sm text-ink">
            完成率: <span className="font-bold text-brand">{rate.toFixed(0)}%</span>
          </span>
        </div>
        <button onClick={load} className="btn-ghost text-sm" disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          刷新
        </button>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      {tasks.length === 0 && !loading ? (
        <div className="card p-8 text-center text-ink-dim">
          还没有责任清单任务。在「任务模板」里建几条。
        </div>
      ) : (
        <div className="card p-4 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-dim text-xs">
                <th className="text-left pb-2 sticky left-0 bg-bg-card">日期</th>
                {tasks.map((t) => (
                  <th key={t.id} className="px-2 pb-2 text-center font-normal whitespace-nowrap">
                    {t.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((d) => {
                const dayMap = grid.get(d);
                const isToday = d === new Date().toISOString().slice(0, 10);
                return (
                  <tr key={d} className="border-t border-border/40">
                    <td
                      className={
                        "py-1.5 pr-2 sticky left-0 bg-bg-card font-mono text-xs " +
                        (isToday ? "text-brand font-bold" : "text-ink-dim")
                      }
                    >
                      {d.slice(5)}
                      {isToday && " (今)"}
                    </td>
                    {tasks.map((t) => {
                      const v = dayMap?.get(t.id);
                      return (
                        <td key={t.id} className="px-2 py-1 text-center">
                          {v === true ? (
                            <Check size={14} className="inline text-accent-600" />
                          ) : v === false ? (
                            <X size={14} className="inline text-warn/60" />
                          ) : (
                            <span className="text-ink-light">·</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
