"""执行 MatchResult 上的 action：杀进程 + 推事件 + 弹窗。

业务模块只依赖 EventSink / EventBus / Notifier 接口，不绑死 SQLite。
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Iterable

import psutil

from comms.event_bus import EventBus
from comms.message_types import (
    ActionType,
    Event,
    EventType,
    MatchResult,
)
from store.repository import EventSink
from ui.notifier import Notifier

_log = logging.getLogger(__name__)


class Killer:
    """执行拦截动作。

    去重策略：
      同一 (pid, rule_id) 在 _dedupe_window_seconds 内不重复弹窗 / 记录。
      但仍重复尝试 kill —— kill 是幂等的，多杀无害。
    """

    def __init__(
        self,
        event_sink: EventSink,
        event_bus: EventBus,
        notifier: Notifier,
        dedupe_window_seconds: int = 60,
    ) -> None:
        self._events = event_sink
        self._bus = event_bus
        self._notifier = notifier
        self._dedupe = dedupe_window_seconds
        self._last_seen: dict[tuple[int, str], float] = {}

    def handle(self, results: Iterable[MatchResult]) -> int:
        """对一批 MatchResult 逐一执行。返回实际命中并处理的数量（已去重）。

        同一进程的多条规则命中：只用其中之一执行动作（按规则 id 排序确定）。
        """
        # 按 pid 聚合，每 pid 只触发一次最严重的动作
        by_pid: dict[int, list[MatchResult]] = defaultdict(list)
        for r in results:
            by_pid[r.process.pid].append(r)

        handled = 0
        now = time.time()
        for pid, hits in by_pid.items():
            # 选最严重的：kill_and_warn > kill_silent > warn_only
            hits.sort(key=lambda h: _action_severity(h.rule.action.type), reverse=True)
            primary = hits[0]
            rule_id = primary.rule.id
            key = (pid, rule_id)
            seen_at = self._last_seen.get(key, 0)
            dedupe_hit = (now - seen_at) < self._dedupe
            self._last_seen[key] = now

            self._dispatch(primary, suppress_user_facing=dedupe_hit)
            handled += 1

        # 清理过期的 dedupe 条目，避免内存涨
        if len(self._last_seen) > 1024:
            cutoff = now - self._dedupe * 2
            self._last_seen = {
                k: v for k, v in self._last_seen.items() if v >= cutoff
            }
        return handled

    def _dispatch(self, match: MatchResult, suppress_user_facing: bool) -> None:
        action = match.rule.action.type
        killed = False
        if action in (ActionType.KILL_AND_WARN.value, ActionType.KILL_SILENT.value):
            killed = self._kill(match.process.pid)

        payload = {
            "rule_id": match.rule.id,
            "rule_name": match.rule.name,
            "pid": match.process.pid,
            "process_name": match.process.name,
            "exe_path": match.process.exe_path,
            "match_reason": match.reason,
            "action": action,
            "killed": killed,
            "user_facing_suppressed": suppress_user_facing,
        }
        ev = Event(type=EventType.BLOCK.value, payload=payload)
        self._events.emit(ev)
        self._bus.publish(ev)

        if suppress_user_facing:
            return
        if action == ActionType.KILL_AND_WARN.value:
            msg = match.rule.action.message or "该应用未被授权使用"
            self._notifier.warn_async(msg)
        elif action == ActionType.WARN_ONLY.value:
            msg = match.rule.action.message or "提醒：该应用使用受限"
            self._notifier.warn_async(msg)

    def _kill(self, pid: int) -> bool:
        try:
            psutil.Process(pid).kill()
            _log.info("killed pid=%s", pid)
            return True
        except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
            _log.warning("kill pid=%s failed: %s", pid, e)
            return False


def _action_severity(action: str) -> int:
    return {
        ActionType.KILL_AND_WARN.value: 3,
        ActionType.KILL_SILENT.value: 2,
        ActionType.WARN_ONLY.value: 1,
    }.get(action, 0)
