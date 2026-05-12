"""活跃判定 (§10.3 + §16.1)。

三个层级：
  - any_input  (键 / 鼠移 / 滚 / 击): GetLastInputInfo
                用于闲置自动 Lock 判定
  - strict_input (键 / 滚 / 点击, 鼠标位移不算): pynput 监听
                用于消费计费 + 赚分判定（鼠标抖动器无效化）

Service 注意：
- 必须运行在用户交互会话；SYSTEM 账号下 GetLastInputInfo 会失败
- pynput 失败时降级仅用 GetLastInputInfo
"""
from __future__ import annotations

import ctypes
import logging
import threading
import time
from ctypes import wintypes
from typing import Callable

_log = logging.getLogger(__name__)


class _LastInputInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def _seconds_since_last_input_any() -> float | None:
    """系统级最后一次输入（含鼠移）距今秒数。失败返回 None。"""
    try:
        lii = _LastInputInfo()
        lii.cbSize = ctypes.sizeof(lii)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
            return None
        tick_now = ctypes.windll.kernel32.GetTickCount()
        # GetTickCount 32-bit, 会绕回；49 天一周期，足够日常使用
        delta_ms = (tick_now - lii.dwTime) & 0xFFFFFFFF
        return delta_ms / 1000.0
    except Exception:
        _log.exception("GetLastInputInfo failed")
        return None


class ActivityDetector:
    """全局单例使用。提供两类活跃判定 + 闲置秒数。

    参数：
      strict_window: 严格活跃窗口（秒），赚分判定
      consumption_window: 消费活跃窗口（秒），扣分判定
    """

    def __init__(
        self,
        strict_window: int = 60,
        consumption_window: int = 120,
    ) -> None:
        self._strict_window = strict_window
        self._consumption_window = consumption_window
        self._last_strict_event_ts: float = 0.0
        self._lock = threading.Lock()
        self._pynput_listeners: list = []
        self._jiggler_callback: Callable[[], None] | None = None
        self._fallback_only = False

    # ── 启停 ─────────────────────────────────────────────────────
    def start(self) -> None:
        try:
            from pynput import keyboard, mouse  # noqa: WPS433
        except ImportError:
            _log.warning(
                "pynput 未安装：严格活跃判定退化为系统级输入检测（鼠标抖动器无法识别）。"
                " 安装命令: pip install pynput"
            )
            self._fallback_only = True
            return

        try:
            kbd = keyboard.Listener(on_press=self._on_key)
            ms = mouse.Listener(on_click=self._on_click, on_scroll=self._on_scroll)
            kbd.start()
            ms.start()
            self._pynput_listeners.extend([kbd, ms])
        except Exception:
            _log.exception("pynput failed to start; falling back to GetLastInputInfo only")
            self._fallback_only = True

    def stop(self) -> None:
        for l in self._pynput_listeners:
            try:
                l.stop()
            except Exception:
                pass
        self._pynput_listeners.clear()

    # ── pynput 回调 ──────────────────────────────────────────────
    def _on_key(self, key) -> None:
        self._mark_strict()

    def _on_click(self, x, y, button, pressed) -> None:
        if pressed:
            self._mark_strict()

    def _on_scroll(self, x, y, dx, dy) -> None:
        self._mark_strict()

    def _mark_strict(self) -> None:
        with self._lock:
            self._last_strict_event_ts = time.monotonic()

    # ── 对外查询 ─────────────────────────────────────────────────
    def seconds_since_any_input(self) -> float:
        s = _seconds_since_last_input_any()
        if s is None:
            return 0.0
        return s

    def seconds_since_strict_input(self) -> float:
        """距上次 key/scroll/click 多久。

        fallback 模式（pynput 不可用）下退化为 any_input —— 此时不再能挡 jiggler。
        """
        if self._fallback_only:
            return self.seconds_since_any_input()
        with self._lock:
            last = self._last_strict_event_ts
        if last == 0:
            return float("inf")
        return time.monotonic() - last

    def is_active_consumption(self) -> bool:
        """消费扣分活跃判定：宽松，鼠移即算。"""
        return self.seconds_since_any_input() <= self._consumption_window

    def is_active_earning(self) -> bool:
        """赚分活跃判定：严格，必须 key/scroll/click。"""
        return self.seconds_since_strict_input() <= self._strict_window

    def is_idle_for(self, threshold_seconds: int) -> bool:
        """是否连续 threshold_seconds 无任何输入。用于闲置 Lock。"""
        return self.seconds_since_any_input() >= threshold_seconds

    # ── 供外部诊断 ───────────────────────────────────────────────
    @property
    def fallback_only(self) -> bool:
        return self._fallback_only
