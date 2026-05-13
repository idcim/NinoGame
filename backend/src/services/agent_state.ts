/** 内存缓存 Agent 最近一次 STATUS (kind=token_decision)。
 *
 * 用途: 家长浏览器设备详情页"现在扣不扣"卡片。
 * 不落库 (每孩子每分钟一条会爆 events 表); 单进程 Map 够用,
 * 多实例部署时换 Redis 缓存。
 */

export interface AgentDecision {
  kind: "token_decision";
  foreground: string | null;
  category: string | null;
  rate: number;
  mode_active: boolean;
  balance: number;
  deducted: number;
  credited: number;
  skip_reason: string | null;
}

export interface CachedState extends AgentDecision {
  updated_at: string;
}

const _cache = new Map<string, CachedState>();

export function setAgentDecision(device_id: string, d: AgentDecision): void {
  _cache.set(device_id, { ...d, updated_at: new Date().toISOString() });
}

export function getAgentDecision(device_id: string): CachedState | null {
  return _cache.get(device_id) ?? null;
}

export function clearAgentDecision(device_id: string): void {
  _cache.delete(device_id);
}
