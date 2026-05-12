"""玩游戏时的浮层 (§15.3)。

设计:
  ┌──────────────┐
  │ 💎 47        │
  │ ⏱ 28 min剩  │
  └──────────────┘

  - 只在: 模式=child + 前台=consumption + 用户活跃  时显示
  - 数字按余额变色: 绿→黄→橙→红
  - 不弹窗、不发声、安静更新
  - 默认右上角, 可拖动
  - frameless + 半透明 + always-on-top + 不进任务栏

实现要点:
  - 必须在 Qt 主线程创建 (QApplication 已在 main.py 启好)
  - 每 2s 刷新 (轻量), 不监听具体事件
  - 全部数据通过注入的 callable 取, 不直接 import 业务类
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

from PySide6.QtCore import Qt, QTimer, QPoint, Slot
from PySide6.QtGui import QColor, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QGraphicsDropShadowEffect

_log = logging.getLogger(__name__)

# 配色
COLOR_OK = "#5cb85c"        # 绿
COLOR_YELLOW = "#e6c533"     # 黄
COLOR_ORANGE = "#e08b2e"     # 橙
COLOR_DANGER = "#dc3545"     # 红
COLOR_TEXT_DIM = "#6f8590"
COLOR_CARD_BG = "rgba(255, 255, 255, 220)"  # 接近不透明的白
COLOR_BORDER = "rgba(220, 230, 235, 200)"


def _color_for_balance(balance: int, daily_cap: int) -> str:
    if balance <= 0:
        return COLOR_DANGER
    ratio = balance / max(1, daily_cap)
    if ratio < 0.20:
        return COLOR_ORANGE
    if ratio < 0.50:
        return COLOR_YELLOW
    return COLOR_OK


class FloatingOverlay(QWidget):
    """Token + 剩余分钟浮层。"""

    def __init__(
        self,
        get_balance: Callable[[], int],
        get_mode: Callable[[], str],
        get_foreground_rate: Callable[[], float | None],
        get_remaining_cap_minutes: Callable[[], int],
        is_active: Callable[[], bool],
        daily_credit_cap: int = 120,
        refresh_seconds: int = 5,  # 之前 2s 偏紧, 5s 对 token 流动够直观且省 CPU
    ) -> None:
        super().__init__()
        self._get_balance = get_balance
        self._get_mode = get_mode
        self._get_foreground_rate = get_foreground_rate
        self._get_remaining_cap = get_remaining_cap_minutes
        self._is_active = is_active
        self._cap = daily_credit_cap
        self._enabled = True

        self._build_window()
        self._build_ui()
        self._position_default()

        self._drag_pos: QPoint | None = None

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh)
        self._timer.start(int(refresh_seconds * 1000))

        # 启动时先评估一次
        self._refresh()

    # ── 窗口属性 ─────────────────────────────────────────────────
    def _build_window(self) -> None:
        self.setWindowFlags(
            Qt.Tool
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.setFixedSize(150, 78)

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 8, 8, 8)

        card = QWidget(self)
        card.setObjectName("card")
        outer.addWidget(card)

        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(18)
        shadow.setOffset(0, 2)
        shadow.setColor(QColor(0, 0, 0, 70))
        card.setGraphicsEffect(shadow)

        v = QVBoxLayout(card)
        v.setContentsMargins(12, 8, 12, 8)
        v.setSpacing(2)

        self._balance_label = QLabel("💎 --", card)
        self._balance_label.setObjectName("balance")
        v.addWidget(self._balance_label)

        self._minutes_label = QLabel("⏱ -- min剩", card)
        self._minutes_label.setObjectName("minutes")
        v.addWidget(self._minutes_label)

        self._apply_color(COLOR_OK)

    def _apply_color(self, accent: str) -> None:
        qss = f"""
        QWidget#card {{
            background-color: {COLOR_CARD_BG};
            border-radius: 12px;
            border: 1px solid {COLOR_BORDER};
        }}
        QLabel#balance {{
            color: {accent};
            font-family: "Microsoft YaHei UI";
            font-size: 16pt;
            font-weight: bold;
        }}
        QLabel#minutes {{
            color: {COLOR_TEXT_DIM};
            font-family: "Microsoft YaHei UI";
            font-size: 10pt;
        }}
        """
        self.setStyleSheet(qss)

    def _position_default(self) -> None:
        screen = QGuiApplication.primaryScreen()
        if screen is None:
            return
        rect = screen.availableGeometry()
        # 右上角内缩 16px
        x = rect.right() - self.width() - 16
        y = rect.top() + 16
        self.move(x, y)

    # ── 显隐 + 刷新 ──────────────────────────────────────────────
    @Slot(bool)
    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        if not enabled:
            self.hide()
        else:
            self._refresh()

    def _should_show(self) -> bool:
        if not self._enabled:
            return False
        try:
            if self._get_mode() != "child":
                return False
            rate = self._get_foreground_rate()
            if rate is None:
                return False
            # 前台是 consumption 才显示 (rate>0 表示费率)
            if rate <= 0:
                return False
            if not self._is_active():
                return False
            return True
        except Exception:
            _log.exception("overlay show check failed")
            return False

    def _refresh(self) -> None:
        if not self._should_show():
            if self.isVisible():
                self.hide()
            return

        try:
            balance = int(self._get_balance())
            rate = float(self._get_foreground_rate() or 1.0)
            rem_cap = int(self._get_remaining_cap())
        except Exception:
            _log.exception("overlay refresh failed")
            return

        # minutes_left = min(可花的 token 等价分钟, 当日剩余可玩分钟)
        if rate > 0:
            balance_minutes = int(balance / rate)
        else:
            balance_minutes = balance
        minutes_left = max(0, min(balance_minutes, rem_cap))

        self._balance_label.setText(f"💎 {balance}")
        self._minutes_label.setText(f"⏱ {minutes_left} min剩")

        accent = _color_for_balance(balance, self._cap)
        self._apply_color(accent)

        if not self.isVisible():
            self.show()

    # ── 拖动 ─────────────────────────────────────────────────────
    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event) -> None:
        if self._drag_pos is not None and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            event.accept()

    def mouseReleaseEvent(self, event) -> None:
        self._drag_pos = None
        event.accept()
