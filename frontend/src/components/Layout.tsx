import { ClipboardList, LogOut, LayoutGrid, MessageSquare, Shield } from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { clearAuth, getParent } from "../lib/auth";

export default function Layout() {
  const nav = useNavigate();
  const parent = getParent();
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
                "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors " +
                (isActive
                  ? "bg-brand-50 text-brand-600"
                  : "text-ink-dim hover:text-ink")
              }
            >
              <MessageSquare size={14} />
              申请
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
                "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 transition-colors " +
                (isActive
                  ? "bg-brand-50 text-brand-600"
                  : "text-ink-dim hover:text-ink")
              }
            >
              <ClipboardList size={14} />
              任务
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
