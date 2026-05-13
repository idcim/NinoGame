/** WebSocket 客户端: 订阅 /ws/parent 的实时事件流。
 *
 * 用法 (React):
 *   const events = useEventStream(); // 返回最近 N 条事件 + 连接状态
 */
import { useEffect, useRef, useState } from "react";
import { getToken } from "./auth";

export interface LiveEvent {
  parent_id: string;
  child_id: string | null;
  device_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

interface IncomingMessage {
  type: string;
  payload?: LiveEvent;
}

export type ConnState = "connecting" | "open" | "closed" | "error";

export interface UseEventStreamResult {
  events: LiveEvent[];
  state: ConnState;
  clear: () => void;
}

const MAX_EVENTS = 80;

export function useEventStream(enabled: boolean = true): UseEventStreamResult {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [state, setState] = useState<ConnState>("connecting");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState("closed");
      return;
    }
    const token = getToken();
    if (!token) {
      setState("closed");
      return;
    }
    // dev: vite proxy 把 /ws/* 转到 backend; prod: 同源
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/parent?token=${encodeURIComponent(token)}`;

    let stopped = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      setState("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setState("open");
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as IncomingMessage;
          if (msg.type === "event" && msg.payload) {
            setEvents((prev) => {
              const next = [msg.payload!, ...prev];
              return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
            });
          }
        } catch {
          /* ignore non-JSON */
        }
      };
      ws.onerror = () => setState("error");
      ws.onclose = () => {
        setState("closed");
        if (!stopped) {
          // 5s 后重连
          reconnectTimer = window.setTimeout(connect, 5000);
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);

  return {
    events,
    state,
    clear: () => setEvents([]),
  };
}
