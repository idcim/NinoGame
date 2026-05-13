import { useEffect, useState } from "react";
import {
  Check,
  Clock,
  Loader2,
  MessageSquare,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { api, ApiError, type UnlockRequest } from "../lib/api";
import { requestStatusLabel, timeAgo } from "../lib/labels";

type Tab = "pending" | "approved" | "rejected" | "all";

export default function Requests() {
  const [tab, setTab] = useState<Tab>("pending");
  const [requests, setRequests] = useState<UnlockRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listRequests(tab);
      setRequests(r.requests);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // LLM 翻译异步执行, 重拉一次让 llm_summary / structured_request 进来
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [tab]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <MessageSquare size={22} className="text-brand" />
            申请
          </h1>
          <p className="text-sm text-ink-dim mt-1">
            孩子发起的"申请游戏时间"请求; 批准后自动下发 temporary_unlock 命令
          </p>
        </div>
        <button onClick={load} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      {/* 状态切换 */}
      <div className="flex gap-2 flex-wrap">
        {(["pending", "approved", "rejected", "all"] as Tab[]).map((t) => (
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
            {t === "pending" ? "待批准" : t === "approved" ? "已批准" : t === "rejected" ? "已拒绝" : "全部"}
          </button>
        ))}
      </div>

      {err && <div className="card p-4 text-warn bg-warn/5 border-warn/30">{err}</div>}

      <div className="space-y-2">
        {requests.length === 0 && !loading && (
          <div className="card p-8 text-center text-ink-dim">没有记录</div>
        )}
        {requests.map((r) => (
          <RequestRow key={r.id} req={r} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function RequestRow({ req, onChanged }: { req: UnlockRequest; onChanged: () => void }) {
  const [approving, setApproving] = useState(false);

  const isPending = req.status === "pending";

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div
          className={
            "w-9 h-9 rounded-full flex items-center justify-center shrink-0 " +
            (req.status === "approved"
              ? "bg-accent/15 text-accent-600"
              : req.status === "rejected"
                ? "bg-warn/15 text-warn"
                : "bg-brand-50 text-brand-600")
          }
        >
          {req.status === "approved" ? (
            <Check size={16} />
          ) : req.status === "rejected" ? (
            <X size={16} />
          ) : (
            <Clock size={16} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">
              {req.display_name || req.child_username || "孩子"}
            </span>
            <span
              className={
                "badge " +
                (req.status === "pending"
                  ? "badge-info"
                  : req.status === "approved"
                    ? "badge-success"
                    : "badge-warn")
              }
            >
              {requestStatusLabel(req.status)}
            </span>
            <span
              className="text-xs text-ink-light"
              title={new Date(req.created_at).toLocaleString()}
            >
              {timeAgo(req.created_at)}
            </span>
          </div>
          <p className="mt-1 text-ink">{req.request_text}</p>

          {/* LLM 翻译摘要 (异步, 几秒后到; 没配 LLM 时 null) */}
          {req.llm_summary && (
            <div className="mt-2 p-2 rounded bg-brand-50/60 border border-brand-50 text-sm text-ink flex items-start gap-2">
              <Sparkles size={14} className="text-brand-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-brand-600 font-medium mb-0.5">AI 摘要</div>
                <div>{req.llm_summary}</div>
                <StructuredHint structured={req.structured_request} />
              </div>
            </div>
          )}

          {req.parent_comment && (
            <p className="mt-1 text-xs text-ink-dim">家长备注: {req.parent_comment}</p>
          )}
        </div>
      </div>

      {isPending && (
        <div className="flex gap-2 justify-end">
          <button
            onClick={async () => {
              if (!confirm(`拒绝来自 ${req.display_name || req.child_username} 的申请?`)) return;
              setApproving(true);
              try {
                await api.rejectRequest(req.id);
                onChanged();
              } finally {
                setApproving(false);
              }
            }}
            className="btn-ghost"
            disabled={approving}
          >
            <X size={14} />
            拒绝
          </button>
          {[10, 30, 60].map((m) => (
            <button
              key={m}
              onClick={async () => {
                setApproving(true);
                try {
                  // 不传 rule_id: server 自动展开为该孩子全部 enabled 规则
                  await api.approveRequest(req.id, { duration_minutes: m });
                  onChanged();
                } finally {
                  setApproving(false);
                }
              }}
              className="btn-primary"
              disabled={approving}
            >
              <Check size={14} />
              批准 {m} 分钟
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StructuredHint({ structured }: { structured: unknown }) {
  if (!structured || typeof structured !== "object") return null;
  const s = structured as {
    duration_minutes?: number;
    activity?: string;
    tone?: string;
    claimed_completions?: string[];
  };
  if (!s.duration_minutes && !s.activity) return null;
  const tone =
    s.tone === "demanding" ? "急切"
    : s.tone === "negotiating" ? "协商"
    : s.tone === "polite" ? "礼貌"
    : null;
  return (
    <div className="text-xs text-ink-dim mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
      {s.duration_minutes && <span>⏱ {s.duration_minutes} 分钟</span>}
      {s.activity && <span>🎮 {s.activity}</span>}
      {tone && <span>语气: {tone}</span>}
      {Array.isArray(s.claimed_completions) && s.claimed_completions.length > 0 && (
        <span>已完成: {s.claimed_completions.join(", ")}</span>
      )}
    </div>
  );
}
