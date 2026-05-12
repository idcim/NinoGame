"""非阻塞警告弹窗。

Service 模式下没有窗口站，MessageBoxW 会失败；
失败时降级为 log，保证主循环不挂。
"""
from __future__ import annotations

import ctypes
import logging
import threading

_log = logging.getLogger(__name__)

# MB_ICONWARNING | MB_TOPMOST | MB_SYSTEMMODAL
_FLAGS = 0x30 | 0x40000 | 0x1000


class Notifier:
    def __init__(self, default_title: str = "NinoGame") -> None:
        self._default_title = default_title

    def warn_async(self, message: str, title: str | None = None) -> None:
        t = threading.Thread(
            target=self._popup,
            args=(message, title or self._default_title),
            daemon=True,
        )
        t.start()

    def _popup(self, message: str, title: str) -> None:
        try:
            ctypes.windll.user32.MessageBoxW(0, message, title, _FLAGS)
        except Exception:
            _log.warning("MessageBoxW failed (running as service?); message=%r", message)
