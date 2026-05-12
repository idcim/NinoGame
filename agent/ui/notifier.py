"""警告弹窗。

所有 dialog 都通过 DialogBridge 调度到 Qt 主线程渲染，
确保从 token_engine / killer / pystray 等工作线程触发时焦点正常。
"""
from __future__ import annotations

import logging
from pathlib import Path

from ui.qt_bridge import get_bridge
from ui.qt_dialogs import COLOR_PRIMARY, COLOR_WARN

_log = logging.getLogger(__name__)


class Notifier:
    def __init__(
        self,
        default_title: str = "NinoGame · 提醒",
        logo_path: str | Path | None = None,
        auto_close_seconds: int = 0,
    ) -> None:
        self._default_title = default_title
        self._logo_path = str(logo_path) if logo_path else None
        self._auto_close = auto_close_seconds

    def warn_async(self, message: str, title: str | None = None) -> None:
        try:
            get_bridge().show_warning(
                title=title or self._default_title,
                message=message,
                logo_path=self._logo_path,
                auto_close_seconds=self._auto_close,
                accent=COLOR_WARN,
            )
        except Exception:
            _log.exception("warn_async 失败; message=%r", message)

    def info_async(self, message: str, title: str | None = None) -> None:
        try:
            get_bridge().show_warning(
                title=title or self._default_title,
                message=message,
                logo_path=self._logo_path,
                auto_close_seconds=self._auto_close,
                accent=COLOR_PRIMARY,
            )
        except Exception:
            _log.exception("info_async 失败; message=%r", message)
