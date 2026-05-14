/** 全局孩子选择上下文 (v0.4.6+).
 *
 * 跨页持久化"当前操作哪个孩子" — 用户在 /rules 选了 nino 后切到 /tasks, 不该重新选.
 *
 * 行为:
 *   - 进入 Layout 后即拉一次 listChildren (loading/error/refresh 三态)
 *   - activeChildId 持久化到 localStorage: ninogame.active_child_id
 *   - 加载完成后若没有持久化值, 或持久化的 id 已不在列表里, 自动 fallback 到列表第一个
 *   - 任何调用 setActiveChildId 立刻写 localStorage
 *   - refresh() 触发重新拉 (新增/删除孩子后调)
 *
 * Dashboard 是多孩子总览, 不强制走这个 context, 但也能调 refresh.
 *
 * 用法:
 *   const { activeChild, activeChildId, setActiveChildId, children } = useChild();
 *   if (!activeChildId) return <NoChildHint />;
 *   ... 用 activeChildId 调 API ...
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, type Child } from "./api";

const STORAGE_KEY = "ninogame.active_child_id";

interface ChildContextValue {
  children: Child[];
  activeChild: Child | null;
  activeChildId: string;
  setActiveChildId: (id: string) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const ChildCtx = createContext<ChildContextValue | null>(null);

function readPersisted(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writePersisted(id: string): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式可能挂掉, 静默 */
  }
}

export function ChildProvider({ children: kids }: { children: ReactNode }) {
  const [childrenList, setChildrenList] = useState<Child[]>([]);
  const [activeChildId, setActiveChildIdState] = useState<string>(readPersisted());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listChildren();
      setChildrenList(r.children);
      // 校验持久化的 id 还在列表里; 不在或没值 → fallback 第一个
      setActiveChildIdState((prev) => {
        const stillThere = r.children.some((c) => c.id === prev);
        if (stillThere) return prev;
        const fallback = r.children[0]?.id || "";
        writePersisted(fallback);
        return fallback;
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载孩子失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setActiveChildId = useCallback((id: string) => {
    writePersisted(id);
    setActiveChildIdState(id);
  }, []);

  const activeChild = useMemo(
    () => childrenList.find((c) => c.id === activeChildId) || null,
    [childrenList, activeChildId],
  );

  const value: ChildContextValue = useMemo(
    () => ({
      children: childrenList,
      activeChild,
      activeChildId,
      setActiveChildId,
      loading,
      error,
      refresh,
    }),
    [childrenList, activeChild, activeChildId, setActiveChildId, loading, error, refresh],
  );

  return <ChildCtx.Provider value={value}>{kids}</ChildCtx.Provider>;
}

export function useChild(): ChildContextValue {
  const v = useContext(ChildCtx);
  if (!v) throw new Error("useChild 必须包在 <ChildProvider> 里");
  return v;
}
