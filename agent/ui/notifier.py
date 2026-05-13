"""警告弹窗。

所有 dialog 都通过 DialogBridge 调度到 Qt 主线程渲染，
确保从 token_engine / killer / pystray 等工作线程触发时焦点正常。

同时把每条通知写入本地 notification_history (托盘"我的消息..."窗口数据源)。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

from ui.qt_bridge import get_bridge
from ui.qt_dialogs import COLOR_PRIMARY, COLOR_WARN

_log = logging.getLogger(__name__)


class Notifier:
    def __init__(
        self,
        default_title: str = "NinoGame · 提醒",
        logo_path: str | Path | None = None,
        auto_close_seconds: int = 0,
        record_history: Callable[[str, str, str], None] | None = None,
    ) -> None:
        self._default_title = default_title
        self._logo_path = str(logo_path) if logo_path else None
        self._auto_close = auto_close_seconds
        # (level, title, body) -> None; None 表示不记录历史 (兼容旧调用)
        self._record_history = record_history

    def _record(self, level: str, title: str, body: str) -> None:
        if self._record_history is None:
            return
        try:
            self._record_history(level, title, body)
        except Exception:
            _log.exception("notification history 写入失败")

    def warn_async(self, message: str, title: str | None = None) -> None:
        full_title = title or self._default_title
        self._record("warn", full_title, message)
        try:
            get_bridge().show_warning(
                title=full_title,
                message=message,
                logo_path=self._logo_path,
                auto_close_seconds=self._auto_close,
                accent=COLOR_WARN,
            )
        except Exception:
            _log.exception("warn_async 失败; message=%r", message)

    def info_async(self, message: str, title: str | None = None) -> None:
        full_title = title or self._default_title
        self._record("info", full_title, message)
        try:
            get_bridge().show_warning(
                title=full_title,
                message=message,
                logo_path=self._logo_path,
                auto_close_seconds=self._auto_close,
                accent=COLOR_PRIMARY,
            )
        except Exception:
            _log.exception("info_async 失败; message=%r", message)
