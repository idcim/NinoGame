import {
  BarChart3,
  Bell,
  Box,
  Database,
  LogOut,
  Package,
  ShieldCheck,
  Sliders,
  Sparkles,
  Users,
} from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { clearAuth, getAdmin } from "../lib/auth";

const NAV = [
  { to: "/", label: "概览", Icon: BarChart3, end: true },
  { to: "/llm", label: "LLM", Icon: Sparkles },
  { to: "/releases", label: "升级包", Icon: Package },
  { to: "/app-categories", label: "应用分类", Icon: Box },
  { to: "/defaults", label: "默认值", Icon: Sliders },
  { to: "/system", label: "系统", Icon: Database },
  { to: "/push", label: "推送", Icon: Bell },
  { to: "/tenants", label: "家长", Icon: Users },
];

export default function Layout() {
  const nav = useNavigate();
  const admin = getAdmin();

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      <header className="border-b border-border bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-brand text-white flex items-center justify-center">
              <ShieldCheck size={18} />
            </div>
            <div>
              <div className="font-bold text-ink leading-none">NinoGame</div>
              <div className="text-[10px] text-ink-dim mt-0.5">管理后台</div>
            </div>
          </Link>

          <nav className="flex items-center gap-1 overflow-x-auto">
            {NAV.map((it) => {
              const Icon = it.Icon;
              return (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end}
                  className={({ isActive }) =>
                    "px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 whitespace-nowrap " +
                    (isActive
                      ? "bg-brand text-white"
                      : "text-ink-dim hover:text-ink hover:bg-bg-soft")
                  }
                >
                  <Icon size={14} />
                  {it.label}
                </NavLink>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3 shrink-0">
            <span className="text-xs text-ink-dim hidden sm:inline">
              {admin?.username}
            </span>
            <button
              onClick={() => {
                clearAuth();
                nav("/login", { replace: true });
              }}
              className="text-ink-dim hover:text-warn"
              title="退出"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-screen-xl w-full mx-auto px-4 sm:px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
