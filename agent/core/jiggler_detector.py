"""鼠标抖动器 / jiggler 检测 (CLAUDE.md §16.1 ②)。

原理:
  每 1s 采样 cursor 位置, 维护最近 60s 的窗口。
  若窗口里有"动" (任意采样差异 > 0), 但全部样本被压在一个小盒子里
  (bounding box 边长 < threshold), 判定机械感 → 当前周期不计赚分
  + emit JIGGLER_ALERT 事件 (家长浏览器实时看到)。

不杀进程, 不阻断使用; 只是"不让你刷 token", 并通知家长。

为什么这个简单方法 work:
  - 真用户: 鼠标偶尔大跨度跳到屏幕另一边 (开浏览器/点托盘/...) →
    box 一下子就拉大几百像素
  - 抖动器: 反复在同一片区域抖动 →  box 始终 < 50-100 px
  组合 "GetLastInputInfo 显示活跃 + 自家 bounding box 小" 几乎只会
  在机械动鼠标场景命中。
"""
from __future__ import annotations

import collections
import ctypes
import logging
import sys
import threading
import time
from typing import Callable

_log = logging.getLogger(__name__)

_IS_WIN = sys.platform == "win32"


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def _get_cursor_pos() -> tuple[int, int] | None:
    if not _IS_WIN:
        return None
    try:
        pt = _POINT()
        ok = ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        if not ok:
            return None
        return int(pt.x), int(pt.y)
    except Exception:
        return None


class JigglerDetector:
    """采样 + 评估机械感。线程安全; 自带后台线程。"""

    def __init__(
        self,
        *,
        sample_interval_seconds: float = 1.0,
        window_size: int = 60,
        box_threshold_px: int = 80,
        min_samples_ratio: float = 0.7,
        alert_callback: Callable[[dict], None] | None = None,
        alert_cooldown_seconds: int = 300,
    ) -> None:
        self._interval = max(0.2, sample_interval_seconds)
        self._win = collections.deque(maxlen=window_size)
        self._box_th = box_threshold_px
        self._min_ratio = min_samples_ratio
        self._alert_cb = alert_callback
        self._alert_cooldown = alert_cooldown_seconds

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._is_mechanical = False
        self._last_alert_at: float = 0.0

    def start(self) -> None:
        if not _IS_WIN:
            _log.info("jiggler_detector: 非 Windows, 跳过")
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="jiggler-detector", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def is_mechanical(self) -> bool:
        with self._lock:
            return self._is_mechanical

    def snapshot(self) -> dict:
        """诊断用; 返回当前窗口的 box / 样本数。"""
        with self._lock:
            samples = list(self._win)
        if not samples:
            return {"samples": 0, "box_w": 0, "box_h": 0, "mechanical": False}
        xs = [p[0] for p in samples]
        ys = [p[1] for p in samples]
        return {
            "samples": len(samples),
            "box_w": max(xs) - min(xs),
            "box_h": max(ys) - min(ys),
            "mechanical": self._is_mechanical,
        }

    # ── 内部 ──────────────────────────────────────────────
    def _loop(self) -> None:
        while not self._stop.is_set():
            pos = _get_cursor_pos()
            if pos is not None:
                with self._lock:
                    self._win.append(pos)
                    self._reevaluate_inlock()
            self._stop.wait(self._interval)

    def _reevaluate_inlock(self) -> None:
        samples = list(self._win)
        min_samples = int(self._win.maxlen * self._min_ratio)
        if len(samples) < min_samples:
            self._is_mechanical = False
            return

        xs = [p[0] for p in samples]
        ys = [p[1] for p in samples]
        box_w = max(xs) - min(xs)
        box_h = max(ys) - min(ys)

        # "动过" = box 至少 > 0; "范围小" = box 每边 < threshold
        moved = (box_w > 0) or (box_h > 0)
        small_box = (box_w < self._box_th) and (box_h < self._box_th)

        was = self._is_mechanical
        self._is_mechanical = bool(moved and small_box)

        # 触发 alert (限频 5min)
        if self._is_mechanical and not was:
            now = time.time()
            if now - self._last_alert_at >= self._alert_cooldown:
                self._last_alert_at = now
                if self._alert_cb is not None:
                    try:
                        self._alert_cb({
                            "samples": len(samples),
                            "box_w": box_w,
                            "box_h": box_h,
                            "threshold_px": self._box_th,
                        })
                    except Exception:
                        _log.exception("jiggler alert callback failed")
