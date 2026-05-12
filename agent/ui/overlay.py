"""Token 浮层 (§15.3 演化版)。

child 模式下永远显示, 三种状态:
  - 消费中 (前台是 consumption + 活跃):
        [💎 图标] 47
        [⏱  图标] 28 min剩
  - 学习中 (前台是 productive + 活跃):
        [💎 图标] 47
        [🎓 图标] 学习中
  - 中性 (浏览器 / 桌面 / 闲置):
        [💎 图标] 47
        [☁ 图标] 余额

emoji 改用 qtawesome (FontAwesome) 矢量图标, 跨系统外观一致。
颜色按余额: 绿 > 50% / 黄 25-50% / 橙 < 25% / 红 = 0
Lock 或 Parent 模式自动隐藏。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

import qtawesome as qta
from PySide6.QtCore import Qt, QTimer, QPoint, Slot, QSize
from PySide6.QtGui import QColor, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtGui import QGuiApplication

_log = logging.getLogger(__name__)

# 配色
COLOR_OK = "#5cb85c"
COLOR_YELLOW = "#e6c533"
COLOR_ORANGE = "#e08b2e"
COLOR_DANGER = "#dc3545"
COLOR_TEXT_DIM = "#6f8590"
COLOR_CARD_BG = "rgba(255, 255, 255, 230)"
COLOR_BORDER = "rgba(220, 230, 235, 220)"

_ICON_SIZE = 18


def _color_for_balance(balance: int, daily_cap: int) -> str:
    if balance <= 0:
        return COLOR_DANGER
    ratio = balance / max(1, daily_cap)
    if ratio < 0.20:
        return COLOR_ORANGE
    if ratio < 0.50:
        return COLOR_YELLOW
    return COLOR_OK


def _icon_pixmap(name: str, color: str, size: int = _ICON_SIZE) -> QPixmap:
    return qta.icon(name, color=color).pixmap(QSize(size, size))


class FloatingOverlay(QWidget):
    """Token + 状态浮层。"""

    def __init__(
        self,
        get_balance: Callable[[], int],
        get_mode: Callable[[], str],
        get_foreground_info: Callable[[], tuple[str, float] | None],
        get_remaining_cap_minutes: Callable[[], int],
        is_active: Callable[[], bool],
        get_active_unlock: Callable[[], tuple[str, int] | None] | None = None,
        daily_credit_cap: int = 120,
        refresh_seconds: int = 5,
    ) -> None:
        """get_active_unlock: 返回 (rule_name, seconds_remaining) 或 None.
        非 None 时浮层优先显示"已放行 X 分钟" + 绿色 gift 图标 + 倒计时。"""
        super().__init__()
        self._get_balance = get_balance
        self._get_mode = get_mode
        self._get_foreground_info = get_foreground_info
        self._get_remaining_cap = get_remaining_cap_minutes
        self._is_active = is_active
        self._get_active_unlock = get_active_unlock
        self._cap = daily_credit_cap
        self._enabled = True

        self._build_window()
        self._build_ui()
        self._position_default()

        self._drag_pos: QPoint | None = None
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh)
        self._timer.start(int(refresh_seconds * 1000))
        self._refresh()

    def _build_window(self) -> None:
        self.setWindowFlags(
            Qt.Tool
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.setFixedSize(170, 88)

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
        v.setContentsMargins(12, 10, 12, 10)
        v.setSpacing(4)

        # 第一行: 钱包图标 + 余额数字
        row1 = QHBoxLayout()
        row1.setSpacing(6)
        self._balance_icon = QLabel(card)
        row1.addWidget(self._balance_icon)
        self._balance_label = QLabel("--", card)
        self._balance_label.setObjectName("balance")
        row1.addWidget(self._balance_label, 1)
        v.addLayout(row1)

        # 第二行: 状态图标 + 状态文字
        row2 = QHBoxLayout()
        row2.setSpacing(6)
        self._status_icon = QLabel(card)
        row2.addWidget(self._status_icon)
        self._status_label = QLabel("--", card)
        self._status_label.setObjectName("status")
        row2.addWidget(self._status_label, 1)
        v.addLayout(row2)

        # 初始着色
        self._apply_color(COLOR_OK)
        self._balance_icon.setPixmap(_icon_pixmap("fa5s.gem", COLOR_OK))
        self._status_icon.setPixmap(_icon_pixmap("fa5s.cloud", COLOR_TEXT_DIM))

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
        QLabel#status {{
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
        x = rect.right() - self.width() - 16
        y = rect.top() + 16
        self.move(x, y)

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
            return self._get_mode() == "child"
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
            info = self._get_foreground_info()
            active = self._is_active()
            rem_cap = int(self._get_remaining_cap())
        except Exception:
            _log.exception("overlay refresh failed")
            return

        self._balance_label.setText(str(balance))
        accent = _color_for_balance(balance, self._cap)
        self._balance_icon.setPixmap(_icon_pixmap("fa5s.gem", accent))

        category = info[0] if info else None
        rate = info[1] if info else 0.0

        # 解锁状态最优先 (孩子最关心"我还有多久玩")
        unlock = None
        if self._get_active_unlock is not None:
            try:
                unlock = self._get_active_unlock()
            except Exception:
                _log.exception("get_active_unlock failed")

        if unlock is not None:
            _, secs = unlock
            mins_left = max(0, secs // 60)
            self._status_label.setText(f"已放行 {mins_left} 分钟")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.gift", COLOR_OK))
            accent = COLOR_OK
        elif category == "consumption" and rate > 0 and active:
            balance_minutes = int(balance / rate) if rate > 0 else balance
            minutes_left = max(0, min(balance_minutes, rem_cap))
            self._status_label.setText(f"{minutes_left} 分钟剩余")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.clock", accent))
        elif category == "productive" and active:
            self._status_label.setText("正在学习")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.graduation-cap", COLOR_OK))
            accent = COLOR_OK
        else:
            self._status_label.setText("余额")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.cloud", COLOR_TEXT_DIM))

        self._apply_color(accent)

        if not self.isVisible():
            self.show()

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
