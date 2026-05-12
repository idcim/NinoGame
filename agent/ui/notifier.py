"""警告弹窗。

P1 默认走 Tkinter 自绘 WarningDialog（漂亮 + 配 logo）；
Tk 不可用（Service 模式 / 无窗口站）时降级到 MessageBoxW；
两者都不可用则只写日志。
"""
from __future__ import annotations

import ctypes
import logging
import threading
from pathlib import Path

from ui.dialogs import COLOR_PRIMARY, COLOR_WARN, WarningDialog

_log = logging.getLogger(__name__)

# 兜底 MessageBoxW flags
_MB_FLAGS = 0x30 | 0x40000 | 0x1000   # ICONWARNING | TOPMOST | SYSTEMMODAL


class Notifier:
    """对外只暴露 warn_async / info_async；细节交给 dialogs。"""

    def __init__(
        self,
        default_title: str = "NinoGame · 提醒",
        logo_path: str | Path | None = None,
        auto_close_seconds: int = 0,
    ) -> None:
        self._default_title = default_title
        self._logo_path = str(logo_path) if logo_path else None
        self._auto_close = auto_close_seconds

    # ── 警告（红橙调） ──────────────────────────────────────────
    def warn_async(self, message: str, title: str | None = None) -> None:
        self._show_async(
            title=title or self._default_title,
            message=message,
            accent=COLOR_WARN,
        )

    # ── 信息（蓝调） ────────────────────────────────────────────
    def info_async(self, message: str, title: str | None = None) -> None:
        self._show_async(
            title=title or self._default_title,
            message=message,
            accent=COLOR_PRIMARY,
        )

    # ── 内部 ────────────────────────────────────────────────────
    def _show_async(self, title: str, message: str, accent: str) -> None:
        try:
            WarningDialog(
                title=title,
                message=message,
                logo_path=self._logo_path,
                button_text="我知道了",
                auto_close_seconds=self._auto_close,
                accent=accent,
            ).show_async()
        except Exception:
            _log.exception("Tk 弹窗失败，降级到 MessageBoxW")
            self._fallback_async(message, title)

    def _fallback_async(self, message: str, title: str) -> None:
        def _popup() -> None:
            try:
                ctypes.windll.user32.MessageBoxW(0, message, title, _MB_FLAGS)
            except Exception:
                _log.warning("MessageBoxW 也失败；message=%r", message)
        threading.Thread(target=_popup, daemon=True).start()
