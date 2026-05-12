/** 浏览器端 JWT 持久化 + 简单状态。 */
const TOKEN_KEY = "ninogame.token";
const PARENT_KEY = "ninogame.parent";

export interface ParentInfo {
  id: string;
  username: string;
  created_at?: string;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getParent(): ParentInfo | null {
  const raw = localStorage.getItem(PARENT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveAuth(token: string, parent: ParentInfo): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(PARENT_KEY, JSON.stringify(parent));
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PARENT_KEY);
}

export function isAuthed(): boolean {
  return !!getToken();
}
