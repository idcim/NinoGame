/** 进程内 pub/sub: agent 上报事件 → 推到对应家长的浏览器 WS。
 *
 * 不持久化, 不跨进程; 多实例部署时需要换 Redis pubsub. P2 单进程够用。
 */

export interface ParentEvent {
  parent_id: string;
  child_id: string | null;
  device_id: string | null;
  event_type: string;
  payload: unknown;
  occurred_at: string;
}

type Handler = (ev: ParentEvent) => void;
const subscribers = new Map<string, Set<Handler>>();

export function subscribeParent(parent_id: string, handler: Handler): () => void {
  let set = subscribers.get(parent_id);
  if (!set) {
    set = new Set();
    subscribers.set(parent_id, set);
  }
  set.add(handler);
  return () => {
    const s = subscribers.get(parent_id);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) subscribers.delete(parent_id);
  };
}

export function publishToParent(ev: ParentEvent): number {
  const set = subscribers.get(ev.parent_id);
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const h of set) {
    try {
      h(ev);
      n++;
    } catch {
      // 单个 handler 失败不影响其他
    }
  }
  return n;
}

export function subscriberCount(parent_id: string): number {
  return subscribers.get(parent_id)?.size ?? 0;
}
