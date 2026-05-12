"""应用分类查询 + 未知 App 入队。

仅本地缓存（AppCategoryRepository）。P2 接入 LLM 后台分类时只换实现。
"""
from __future__ import annotations

import logging
from datetime import datetime

from comms.message_types import (
    AppCategory,
    AppCategoryName,
    Event,
    EventType,
    ProcessSnapshot,
)
from store.repository import (
    AppCategoryRepository,
    EventSink,
    UnknownAppQueue,
)

_log = logging.getLogger(__name__)

# 默认归 neutral 的进程（避免每次都报"未知"）
_SYSTEM_PROCESSES = {
    "system", "system idle process", "registry", "smss.exe", "csrss.exe",
    "wininit.exe", "services.exe", "lsass.exe", "winlogon.exe",
    "svchost.exe", "explorer.exe", "dwm.exe", "taskhostw.exe",
    "fontdrvhost.exe", "ctfmon.exe", "runtimebroker.exe",
    "searchhost.exe", "shellexperiencehost.exe", "sihost.exe",
    "applicationframehost.exe", "startmenuexperiencehost.exe",
    "conhost.exe", "rundll32.exe", "audiodg.exe",
}


class Classifier:
    def __init__(
        self,
        repo: AppCategoryRepository,
        unknown_queue: UnknownAppQueue,
        event_sink: EventSink,
    ) -> None:
        self._repo = repo
        self._queue = unknown_queue
        self._events = event_sink
        self._reported_unknown: set[str] = set()  # 同一进程同会话只入队一次

    def classify(self, snap: ProcessSnapshot) -> AppCategory:
        """返回非 None；未知应用归 neutral 并入队（默认放行）。"""
        ident = (snap.name or "").lower()
        if not ident:
            return AppCategory(
                app_identifier="(unknown)",
                category=AppCategoryName.NEUTRAL.value,
                source="fallback",
            )
        if ident in _SYSTEM_PROCESSES:
            return AppCategory(
                app_identifier=ident,
                category=AppCategoryName.NEUTRAL.value,
                sub_type="system",
                rate_multiplier=0.0,
                source="builtin",
            )

        cat = self._repo.get(ident)
        if cat is not None:
            return cat

        # 未知 → 入队 + 上报事件 + 当作 neutral 放行
        if ident not in self._reported_unknown:
            self._reported_unknown.add(ident)
            window = snap.window_titles[0] if snap.window_titles else ""
            try:
                self._queue.enqueue(ident, snap.exe_path, window, datetime.utcnow())
            except Exception:
                _log.exception("unknown_apps_queue.enqueue failed")
            self._events.emit(Event(
                type=EventType.UNKNOWN_APP.value,
                payload={
                    "app_identifier": ident,
                    "exe_path": snap.exe_path,
                    "window_title": window,
                },
            ))
        return AppCategory(
            app_identifier=ident,
            category=AppCategoryName.NEUTRAL.value,
            source="unknown_fallback",
        )
