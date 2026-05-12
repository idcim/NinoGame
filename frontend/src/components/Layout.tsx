import { LogOut } from "lucide-react";
import { Link, Outlet, useNavigate } from "react-router-dom";
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
