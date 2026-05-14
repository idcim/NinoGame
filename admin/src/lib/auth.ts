/** Admin 浏览器端 JWT 持久化. 跟 parent 用不同的 localStorage key, 不冲突. */
const TOKEN_KEY = "ninogame.admin.token";
const ADMIN_KEY = "ninogame.admin.info";

export interface AdminInfo {
  id: string;
  username: string;
  display_name: string | null;
  created_at?: string;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getAdmin(): AdminInfo | null {
  const raw = localStorage.getItem(ADMIN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveAuth(token: string, admin: AdminInfo): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ADMIN_KEY, JSON.stringify(admin));
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADMIN_KEY);
}

export function isAuthed(): boolean {
  return !!getToken();
}
