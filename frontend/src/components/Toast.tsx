import { useState, useCallback, useRef, createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Bell, X } from "lucide-react";

export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone?: "info" | "warn" | "ok";
  /** 点击 toast 跳转的路径; 不传则点了只关闭 */
  link?: string;
  /** 毫秒, 默认 6000 */
  duration?: number;
}

interface ToastContextValue {
  push: (t: Omit<ToastItem, "id">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // 没在 Provider 内时静默 no-op, 避免崩溃
    return { push: () => undefined };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((t: Omit<ToastItem, "id">) => {
    idRef.current += 1;
    const id = idRef.current;
    setItems((prev) => [...prev, { ...t, id }]);
    const duration = t.duration ?? 6000;
    if (duration > 0) {
      window.setTimeout(() => {
        setItems((prev) => prev.filter((it) => it.id !== id));
      }, duration);
    }
  }, []);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {/* 浮层容器: 固定右上角, 不影响 layout */}
      <div className="fixed top-16 right-4 z-50 space-y-2 max-w-sm pointer-events-none">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const tone = item.tone ?? "info";
  const cls =
    tone === "warn"
      ? "bg-warn/95 text-white border-warn"
      : tone === "ok"
        ? "bg-accent/95 text-white border-accent"
        : "bg-brand/95 text-white border-brand";

  const Body = (
    <div
      className={
        "card pointer-events-auto px-4 py-3 flex items-start gap-3 border shadow-lg " +
        cls +
        " animate-fade-in"
      }
    >
      <Bell size={18} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{item.title}</div>
        {item.body && (
          <div className="text-xs opacity-90 mt-0.5 break-words">{item.body}</div>
        )}
        {item.link && (
          <div className="text-xs underline mt-1">点击查看 →</div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }}
        className="opacity-70 hover:opacity-100"
        title="关闭"
      >
        <X size={14} />
      </button>
    </div>
  );

  if (item.link) {
    return (
      <Link to={item.link} onClick={onClose} className="block">
        {Body}
      </Link>
    );
  }
  return Body;
}

// 动画 keyframes 在 index.css 里定义 (.animate-fade-in)
