import { useEffect, useMemo, useState } from "react";
import { ClipboardList, Info, LogOut, LayoutGrid, MessageSquare, Shield } from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { clearAuth, getParent } from "../lib/auth";
import { useEventStream } from "../lib/eventStream";
import { useToast } from "./Toast";

export default function Layout() {
  const nav = useNavigate();
  const parent = getParent();
  const toast = useToast();
  const [pendingTasks, setPendingTasks] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);

  // 全局事件流 (Dashboard 也会单独开一个 hook, 这里再开一条 WS 不大;
  // 简单可靠胜于过早抽象). 用于推送 toast + 触发 badge 增量。
  const stream = useEventStream();

  // 拉 pending count: 启动 + 每 30s + 收到关键事件时立即拉
  async function refreshCounts() {
    try {
      const r = await api.getPendingCounts();
      setPendingTasks(r.pending_tasks);
      setPendingRequests(r.pending_requests);
    } catch {
      /* 静默, 不影响 UI */
    }
  }
  useEffect(() => {
    refreshCounts();
    const t = setInterval(refreshCounts, 30_000);
    return () => clearInterval(t);
  }, []);

  // 监听最新事件 → toast + 拉计数
  const latestKey = useMemo(
    () => (stream.events.length > 0 ? stream.events[0].occurred_at : ""),
    [stream.events],
  );
  useEffect(() => {
    if (stream.events.length === 0) return;
    const ev = stream.events[0];
    const p = (ev.payload || {}) as Record<string, unknown>;
    if (ev.event_type === "task_claim") {
      toast.push({
        title: "孩子申报任务完成",
        body: `${p.task_name ?? "任务"} → +${p.reward_tokens ?? 0} token, 待审批`,
        tone: "info",
        link: "/tasks",
      });
      refreshCounts();
    } else if (ev.event_type === "unlock_request") {
      toast.push({
        title: "孩子申请游戏时间",
        body: typeof p.request_text === "string" ? `「${p.request_text.slice(0, 40)}」` : "新申请",
        tone: "info",
        link: "/requests",
      });
      refreshCounts();
    } else if (ev.event_type === "behavior_anomaly") {
      const today = p.today_minutes ?? "?";
      const avg = p.baseline_avg_minutes ?? "?";
      toast.push({
        title: "行为基线异常",
        body: `今日 ${p.category ?? "?"} ${today} 分 · 平均 ${avg} 分`,
        tone: "warn",
      });
    } else if (ev.event_type === "block") {
      toast.push({
        title: "应用被拦截",
        body: `${p.process_name ?? "?"} · 规则匹配`,
        tone: "warn",
      });
    } else if (ev.event_type === "jiggler_alert") {
      toast.push({
        title: "刷分嫌疑",
        body: "鼠标抖动器检测命中, 详见事件流",
        tone: "warn",
      });
    }
  }, [latestKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-border/60">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group">
            <img src="/logo.png" alt="NinoGame" className="w-8 h-8 rounded-md" />
            <span className="font-bold text-ink group-hover:text-brand">
              NinoGame · 家长后台
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors " +
                (isActive
                  ? "bg-brand-50 text-brand-600"
                  : "text-ink-dim hover:text-ink")
              }
            >
              <LayoutGrid size={14} />
              概览
            </NavLink>
            <NavLink
              to="/requests"
              className={({ isActive }) =>
                "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors relative " +
                (isActive
                  ? "bg-brand-50 text-brand-600"
                  : "text-ink-dim hover:text-ink")
              }
            >
              <MessageSquare size={14} />
              申请
              {pendingRequests > 0 && (
                <span className="bg-warn text-white text-[10px] font-bold rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
                  {pendingRequests > 99 ? "99+" : pendingRequests}
                </span>
              )}
            </NavLink>
            <NavLink
              to="/rules"
              className={({ isActive }) =>
                "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors " +
                (isActive
                  ? "bg-brand-50 text-brand-600"
                  : "text-ink-dim hover:text-ink")
              }
            >
              <Shield size={14} />
              规则
            </NavLink>
            <NavLink
              to="/tasks"
              className={({ isActive }) =>
                "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors relative " +
                (isActive
                  ? "bg-brand-50 text-brand-600"
                  : "text-ink-dim hover:text-ink")
              }
            >
              <ClipboardList size={14} />
              任务
              {pendingTasks > 0 && (
                <span className="bg-warn text-white text-[10px] font-bold rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
                  {pendingTasks > 99 ? "99+" : pendingTasks}
                </span>
              )}
            </NavLink>
            <NavLink
              to="/about"
              className={({ isActive }) =>
                "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors " +
                (isActive
                  ? "bg-brand-50 text-brand-600"
                  : "text-ink-dim hover:text-ink")
              }
            >
              <Info size={14} />
              关于
            </NavLink>
          </nav>
          <div className="flex items-center gap-3 text-sm text-ink-dim">
            <span>{parent?.username || "未登录"}</span>
            <button
              type="button"
              onClick={() => {
                clearAuth();
                nav("/login", { replace: true });
              }}
              className="text-ink-dim hover:text-warn flex items-center gap-1"
              title="退出登录"
            >
              <LogOut size={16} />
              退出
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
      <footer className="text-center text-xs text-ink-light py-4">
        让系统逐步退场 — NinoGame
      </footer>
    </div>
  );
}
