import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  ClipboardList,
  Info,
  LogOut,
  LayoutGrid,
  Menu,
  MessageSquare,
  Package,
  Settings,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { clearAuth, getParent } from "../lib/auth";
import { useEventStream } from "../lib/eventStream";
import { useToast } from "./Toast";

export default function Layout() {
  const nav = useNavigate();
  const location = useLocation();
  const parent = getParent();
  const toast = useToast();
  const [pendingTasks, setPendingTasks] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  // 路由切换后自动关闭移动端菜单 (孩子点了链接, 菜单不该还盖在那)
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

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

  // 导航项 (桌面横排 + 移动端竖向下拉复用)
  const navItems: Array<{
    to: string;
    label: string;
    Icon: typeof LayoutGrid;
    end?: boolean;
    badge?: number;
  }> = [
    { to: "/", label: "概览", Icon: LayoutGrid, end: true },
    { to: "/requests", label: "申请", Icon: MessageSquare, badge: pendingRequests },
    { to: "/rules", label: "规则", Icon: Shield },
    { to: "/tasks", label: "任务", Icon: ClipboardList, badge: pendingTasks },
    { to: "/reports", label: "报表", Icon: BarChart3 },
    { to: "/llm-config", label: "LLM", Icon: Sparkles },
    { to: "/releases", label: "升级包", Icon: Package },
    { to: "/child-settings", label: "设置", Icon: Settings },
    { to: "/about", label: "关于", Icon: Info },
  ];

  function renderNavLink(
    item: (typeof navItems)[number],
    variant: "desktop" | "mobile",
  ) {
    const { to, label, Icon, end, badge } = item;
    return (
      <NavLink
        key={to}
        to={to}
        end={end}
        className={({ isActive }) =>
          (variant === "desktop"
            ? "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors relative "
            : "px-4 py-3 rounded-md text-base flex items-center gap-3 transition-colors relative w-full ") +
          (isActive
            ? "bg-brand-50 text-brand-600"
            : "text-ink-dim hover:text-ink hover:bg-brand-50/40")
        }
      >
        <Icon size={variant === "desktop" ? 14 : 18} />
        {label}
        {badge !== undefined && badge > 0 && (
          <span className="bg-warn text-white text-[10px] font-bold rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </NavLink>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-border/60 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-2 sm:gap-3 group min-w-0">
            <img src="/logo.png" alt="NinoGame" className="w-8 h-8 rounded-md flex-shrink-0" />
            <span className="font-bold text-ink group-hover:text-brand truncate text-sm sm:text-base">
              <span className="hidden xs:inline">NinoGame · </span>家长后台
            </span>
          </Link>

          {/* 桌面端横向 nav (≥md 显示) */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((it) => renderNavLink(it, "desktop"))}
          </nav>

          {/* 右侧: 用户名 + 退出 + 移动端汉堡 */}
          <div className="flex items-center gap-2 sm:gap-3 text-sm text-ink-dim">
            <span className="hidden sm:inline">{parent?.username || "未登录"}</span>
            <button
              type="button"
              onClick={() => {
                clearAuth();
                nav("/login", { replace: true });
              }}
              className="hidden md:flex text-ink-dim hover:text-warn items-center gap-1"
              title="退出登录"
            >
              <LogOut size={16} />
              退出
            </button>
            {/* 移动端汉堡按钮 (<md 显示) */}
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="md:hidden p-2 rounded-md text-ink hover:bg-brand-50 transition-colors"
              aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
            >
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {/* 移动端下拉菜单 */}
        {menuOpen && (
          <div className="md:hidden border-t border-border/60 bg-white px-4 py-3 space-y-1 shadow-lg">
            {navItems.map((it) => renderNavLink(it, "mobile"))}
            <div className="border-t border-border/60 mt-2 pt-2 flex items-center justify-between px-4">
              <span className="text-sm text-ink-dim">{parent?.username || "未登录"}</span>
              <button
                type="button"
                onClick={() => {
                  clearAuth();
                  nav("/login", { replace: true });
                }}
                className="text-sm text-warn flex items-center gap-1.5 py-2 px-3 rounded-md hover:bg-warn/5"
              >
                <LogOut size={16} />
                退出
              </button>
            </div>
          </div>
        )}
      </header>
      <main className="flex-1">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
          <Outlet />
        </div>
      </main>
      <footer className="text-center text-xs text-ink-light py-4">
        让系统逐步退场 — NinoGame
      </footer>
    </div>
  );
}
