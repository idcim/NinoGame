import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogIn, UserPlus } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { saveAuth } from "../lib/auth";

type Mode = "login" | "register";

export default function Login() {
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const resp =
        mode === "login"
          ? await api.login(username.trim(), password)
          : await api.register(username.trim(), password);
      saveAuth(resp.token, resp.parent);
      nav("/", { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "请求失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-50 to-white p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <img src="/logo.png" alt="NinoGame" className="w-20 h-20 rounded-xl mb-3" />
          <h1 className="text-xl font-bold text-ink">NinoGame · 家长后台</h1>
          <p className="text-sm text-ink-dim mt-1">让系统逐步退场</p>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-4">
          <div>
            <label className="label">家长用户名</label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              required
              minLength={3}
            />
          </div>
          <div>
            <label className="label">密码</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={8}
            />
          </div>

          {err && (
            <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded-lg px-3 py-2">
              {err}
            </div>
          )}

          <button type="submit" className="btn-primary w-full justify-center" disabled={loading}>
            {mode === "login" ? <LogIn size={16} /> : <UserPlus size={16} />}
            {loading ? "处理中..." : mode === "login" ? "登录" : "注册并登录"}
          </button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setErr(null);
            }}
            className="block w-full text-center text-sm text-ink-dim hover:text-brand"
          >
            {mode === "login" ? "还没账号? 注册一个 →" : "已有账号? 去登录 →"}
          </button>
        </form>

        <p className="text-xs text-ink-light text-center mt-4">
          首次使用先注册一个家长账号; 单机部署不限制注册数量
        </p>
      </div>
    </div>
  );
}
