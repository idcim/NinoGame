import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogIn, Shield } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { saveAuth } from "../lib/auth";

export default function Login() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const resp = await api.login(username.trim(), password);
      saveAuth(resp.token, resp.admin);
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
          <div className="w-20 h-20 rounded-xl mb-3 bg-brand text-white flex items-center justify-center">
            <Shield size={36} />
          </div>
          <h1 className="text-xl font-bold text-ink">NinoGame · 管理后台</h1>
          <p className="text-sm text-ink-dim mt-1">运营 / 超管视角</p>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-4">
          <div>
            <label className="label">Admin 用户名</label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              required
              minLength={1}
            />
          </div>
          <div>
            <label className="label">密码</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              minLength={6}
            />
          </div>
          {err && (
            <div className="text-sm text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2">
              {err}
            </div>
          )}
          <button type="submit" className="btn-primary w-full" disabled={loading}>
            <LogIn size={16} />
            {loading ? "登录中..." : "登录"}
          </button>
        </form>

        <p className="text-xs text-ink-light text-center mt-4 leading-relaxed">
          首个 admin 账号通过环境变量 <code>ADMIN_BOOTSTRAP_USERNAME / PASSWORD</code> 创建,
          server 启动时如 admin_accounts 表为空则自动写入。
        </p>
      </div>
    </div>
  );
}
