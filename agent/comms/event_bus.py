"""进程内事件总线。

设计目标：让 core/* 之间解耦，不必互相 import。
- killer 触发 BLOCK -> event_bus.publish(...) -> notifier 弹窗 / event_sink 写库
- session_manager 触发 SESSION_OPEN -> tray_icon 更新图标 / token_engine 启动循环

简单同步发布订阅；订阅者抛出的异常不影响其他订阅者。
"""
from __future__ import annotations

import logging
import threading
from collections import defaultdict
from typing import Callable

from comms.message_types import Event

_log = logging.getLogger(__name__)


class EventBus:
    def __init__(self) -> None:
        self._subscribers: dict[str, list[Callable[[Event], None]]] = defaultdict(list)
        self._lock = threading.Lock()

    def subscribe(self, event_type: str, handler: Callable[[Event], None]) -> None:
        with self._lock:
            self._subscribers[event_type].append(handler)

    def publish(self, event: Event) -> None:
        with self._lock:
            handlers = list(self._subscribers.get(event.type, []))
            handlers.extend(self._subscribers.get("*", []))
        for h in handlers:
            try:
                h(event)
            except Exception:
                _log.exception("event handler failed for type=%s", event.type)


# 进程级单例
_default_bus: EventBus | None = None


def default_bus() -> EventBus:
    global _default_bus
    if _default_bus is None:
        _default_bus = EventBus()
    return _default_bus
