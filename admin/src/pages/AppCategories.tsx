import { useEffect, useState } from "react";
import { Box, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError, type AppCategoryRow } from "../lib/api";

const CATEGORY_LABEL: Record<string, string> = {
  consumption: "消耗类",
  productive: "学习类",
  neutral: "中性",
};
const SOURCE_LABEL: Record<string, string> = {
  system: "预置 seed",
  llm: "LLM 分类",
  admin: "Admin 手动",
  parent: "家长 override",
};

export default function AppCategories() {
  const [list, setList] = useState<AppCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [editing, setEditing] = useState<AppCategoryRow | "new" | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listAppCategories(filter || undefined);
      setList(r.categories);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [filter]);

  async function del(id: string, name: string) {
    if (!confirm(`删除 ${name}? 不影响家长 per-child override 行.`)) return;
    try { await api.deleteAppCategory(id); load(); }
    catch (e) { alert(e instanceof ApiError ? e.message : "删除失败"); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <Box size={22} className="text-brand" />
            应用分类 (全局)
          </h1>
          <p className="text-sm text-ink-dim mt-1">
            仅显示 child_id IS NULL 的全局行; 家长 per-child override 不在此页
          </p>
        </div>
        <div className="flex gap-2">
          <select className="input max-w-[150px]" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">全部来源</option>
            <option value="system">预置 seed</option>
            <option value="llm">LLM 分类</option>
            <option value="admin">Admin 手动</option>
          </select>
          <button onClick={load} className="btn-ghost" disabled={loading}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
          <button onClick={() => setEditing("new")} className="btn-primary">
            <Plus size={14} />
            添加
          </button>
        </div>
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      <div className="card divide-y divide-border/60">
        {list.length === 0 && !loading ? (
          <div className="p-8 text-center text-ink-dim text-sm">没有匹配的行</div>
        ) : (
          list.map((c) => (
            <div key={c.id} className="p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold">{c.app_identifier}</span>
                  <span className="badge badge-muted">{CATEGORY_LABEL[c.category]}</span>
                  {c.sub_type && <span className="text-xs text-ink-light">{c.sub_type}</span>}
                  <span className="text-xs text-ink-light">{SOURCE_LABEL[c.classification_source] || c.classification_source}</span>
                </div>
                {c.display_name && (
                  <div className="text-sm text-ink-dim mt-0.5">{c.display_name}</div>
                )}
              </div>
              <button onClick={() => setEditing(c)} className="text-xs text-brand hover:underline">编辑</button>
              <button onClick={() => del(c.id, c.display_name || c.app_identifier)}
                className="p-1.5 text-ink-dim hover:text-warn">
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      {editing && (
        <Editor
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function Editor({
  row,
  onClose,
  onSaved,
}: {
  row: AppCategoryRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [appIdent, setAppIdent] = useState(row?.app_identifier ?? "");
  const [category, setCategory] = useState<"consumption" | "productive" | "neutral">(
    (row?.category as "consumption" | "productive" | "neutral") ?? "neutral",
  );
  const [subType, setSubType] = useState(row?.sub_type ?? "unknown");
  const [displayName, setDisplayName] = useState(row?.display_name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.upsertAppCategory({
        app_identifier: appIdent.trim().toLowerCase(),
        category,
        sub_type: subType.trim() || "unknown",
        display_name: displayName.trim() || null,
        rate_multiplier: 1.0,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="card p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-4">{row ? "编辑" : "添加"}应用分类</h3>
        <div className="space-y-3">
          <div>
            <label className="label">进程名 / app_identifier</label>
            <input className="input font-mono" value={appIdent}
              onChange={(e) => setAppIdent(e.target.value)}
              disabled={!!row} placeholder="如 chrome.exe" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">分类</label>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value as "consumption" | "productive" | "neutral")}>
                <option value="consumption">消耗类</option>
                <option value="productive">学习类</option>
                <option value="neutral">中性</option>
              </select>
            </div>
            <div>
              <label className="label">子类型 (sub_type)</label>
              <input className="input" value={subType} onChange={(e) => setSubType(e.target.value)} placeholder="game / video / code …" />
            </div>
          </div>
          <div>
            <label className="label">显示名</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如 Google Chrome / 哔哩哔哩" />
          </div>
          {err && <div className="text-sm text-warn">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-ghost" disabled={busy}>取消</button>
            <button onClick={save} className="btn-primary" disabled={busy || !appIdent.trim()}>
              {busy ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
