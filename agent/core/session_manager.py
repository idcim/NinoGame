"""会话与模式状态机 (§4.2 + §10.1)。

模式：lock / child / parent / limited_free
P1 主流：
  - 启动进 child（device_type=child_primary，§4.3 #24）
  - child 模式下闲置 idle_lock_minutes 分钟 → 自动 Lock
  - Lock 后 token_engine 自动停止扣分（active_session_id 返回 None）
  - 退出 Lock 在 P1 没有 UI，等 Step 7 的 tray menu

P2 会接管：PIN 解锁、Parent 模式、limited_free。
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime

from comms.event_bus import EventBus
from comms.message_types import (
    Event,
    EventType,
    Session,
    SessionEndReason,
    SessionMode,
)
from core.activity_detector import ActivityDetector
from store.repository import EventSink, SessionRepository

_log = logging.getLogger(__name__)


class SessionManager:
    def __init__(
        self,
        sessions: SessionRepository,
        events: EventSink,
        bus: EventBus,
        activity: ActivityDetector,
        idle_lock_minutes: int = 10,
        tick_seconds: int = 30,
    ) -> None:
        self._sessions = sessions
        self._events = events
        self._bus = bus
        self._activity = activity
        self._idle_threshold = idle_lock_minutes * 60
        self._tick = tick_seconds

        self._mode: str = SessionMode.LOCK.value
        self._session_id: str | None = None
        self._session_started_at: datetime | None = None
        self._session_active_seconds: int = 0
        self._lock = threading.Lock()

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ── 启停 ─────────────────────────────────────────────────────
    def start(self, initial_mode: str = SessionMode.CHILD.value) -> None:
        self.change_mode(initial_mode, end_reason=SessionEndReason.MANUAL_LOCK.value)
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="session-manager", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        self._close_active_session(SessionEndReason.SHUTDOWN.value)

    # ── 状态查询 ─────────────────────────────────────────────────
    @property
    def mode(self) -> str:
        return self._mode

    def active_session_id(self) -> str | None:
        """token_engine 看到 None 就停计费。child/limited_free 才返回 id。"""
        with self._lock:
            if self._mode in (SessionMode.CHILD.value, SessionMode.LIMITED_FREE.value):
                return self._session_id
            return None

    # ── 主循环：闲置检测 ──────────────────────────────────────────
    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._check_idle()
            except Exception:
                _log.exception("session manager tick failed")
            self._stop.wait(self._tick)

    def _check_idle(self) -> None:
        with self._lock:
            mode = self._mode

        if mode == SessionMode.CHILD.value:
            # Child 闲置 N 分钟 → 自动 Lock
            if self._activity.is_idle_for(self._idle_threshold):
                _log.info("闲置 %ds 触发自动锁定", self._idle_threshold)
                self.change_mode(
                    SessionMode.LOCK.value,
                    end_reason=SessionEndReason.IDLE.value,
                )
        elif mode == SessionMode.LOCK.value:
            # Lock + 最近 30s 有任意输入 → 自动恢复 Child
            # (用户回来直接用, 不用再点"解锁使用")
            if self._activity.seconds_since_any_input() < 30:
                _log.info("锁定中检测到用户活动, 自动恢复 Child 模式")
                self.change_mode(
                    SessionMode.CHILD.value,
                    end_reason=SessionEndReason.SWITCHED.value,
                )

    # ── 模式切换 ─────────────────────────────────────────────────
    def change_mode(self, new_mode: str, end_reason: str) -> None:
        with self._lock:
            if self._mode == new_mode and self._session_id is not None:
                _log.info("模式切换跳过: 当前已在 %s 模式", new_mode)
                return
            old_mode = self._mode

            # 关旧会话（若有）
            if self._session_id is not None:
                self._close_active_session_inlock(end_reason)

            self._mode = new_mode

            # 开新会话（仅 child / limited_free）
            if new_mode in (SessionMode.CHILD.value, SessionMode.LIMITED_FREE.value):
                self._open_session_inlock(new_mode)

        # publish 不在 lock 内（避免回调死锁）
        if new_mode != old_mode:
            _log.info("模式切换: %s → %s (原因: %s)", old_mode, new_mode, end_reason)
            ev = Event(
                type=EventType.STATUS.value,
                payload={
                    "kind": "mode_change",
                    "old": old_mode,
                    "new": new_mode,
                    "reason": end_reason,
                },
            )
            self._events.emit(ev)
            self._bus.publish(ev)

    # ── 内部 ─────────────────────────────────────────────────────
    def _open_session_inlock(self, mode: str) -> None:
        sid = f"sess_{uuid.uuid4().hex[:12]}"
        started = datetime.utcnow()
        s = Session(id=sid, mode=mode, started_at=started)
        try:
            self._sessions.open_session(s)
        except Exception:
            _log.exception("open_session failed")
        self._session_id = sid
        self._session_started_at = started
        self._session_active_seconds = 0

        ev = Event(type=EventType.SESSION_OPEN.value, payload={"session_id": sid, "mode": mode})
        self._events.emit(ev)
        self._bus.publish(ev)

    def _close_active_session(self, end_reason: str) -> None:
        with self._lock:
            self._close_active_session_inlock(end_reason)

    def _close_active_session_inlock(self, end_reason: str) -> None:
        if self._session_id is None:
            return
        sid = self._session_id
        started = self._session_started_at or datetime.utcnow()
        ended = datetime.utcnow()
        active_seconds = int((ended - started).total_seconds())
        try:
            self._sessions.close_session(
                session_id=sid,
                ended_at=ended,
                end_reason=end_reason,
                total_active_seconds=active_seconds,
                total_tokens_consumed=0,  # 由 ledger 重算时可填，P1 留 0
            )
        except Exception:
            _log.exception("close_session failed")
        ev = Event(
            type=EventType.SESSION_CLOSE.value,
            payload={
                "session_id": sid,
                "end_reason": end_reason,
                "active_seconds": active_seconds,
            },
        )
        self._events.emit(ev)
        self._bus.publish(ev)

        self._session_id = None
        self._session_started_at = None
        self._session_active_seconds = 0
