"""Token 浮层 (§15.3 演化版)。

child 模式下永远显示, 状态优先级 (上覆盖下):
  1. 限免中 (free_pass_secs > 0):
        [💎 token]  47
        [🎁 限免]  限免中 23 分
  2. 已放行 (unlock 活跃):
        [💎 token]  47
        [🔓 放行]  已放行 25 分
  3. 消费中 (前台是 consumption + rate > 0):
        [💎 token]  47
        [⏱ 时间]  可玩 47 分钟
  4. 默认 (浏览器 / 桌面 / 闲置):
        [💎 token]  47
        [⏱ 时间]  可玩 47 分钟

颜色按 token: 绿 > 50% / 黄 25-50% / 橙 < 25% / 红 = 0
Lock 或 Parent 模式自动隐藏。

(决策 #33 后已删 "学习中 / productive" 死分支, 自动挣分链路下线;
 token 命名替代 "余额", 概念统一。)
"""
from __future__ import annotations

import logging
from typing import Callable

import qtawesome as qta
from PySide6.QtCore import Qt, QTimer, QPoint, Slot, QSize
from PySide6.QtGui import QColor, QPixmap
from PySide6.QtWidgets import (
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
COLOR_GIFT = "#e6a23c"
COLOR_CARD_BG = "rgba(255, 255, 255, 230)"
COLOR_BORDER = "rgba(220, 230, 235, 220)"

_ICON_SIZE = 16


def _color_for_token(balance: int, daily_cap: int) -> str:
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
        get_free_pass_seconds: Callable[[], int] | None = None,
        get_consumption_rate_per_minute: Callable[[], float] | None = None,
        daily_credit_cap: int = 120,
        refresh_seconds: int = 5,
        on_double_click: Callable[[], None] | None = None,
    ) -> None:
        """get_active_unlock: 返回 (rule_name, seconds_remaining) 或 None.
        get_free_pass_seconds: 限免剩余秒数, 0 表无。
        get_consumption_rate_per_minute: token/分钟 (默认 1.0), 用于算可玩分钟数。
        on_double_click: 双击浮层时调用 (通常拉起状态面板)。"""
        super().__init__()
        self._get_balance = get_balance
        self._get_mode = get_mode
        self._get_foreground_info = get_foreground_info
        self._get_remaining_cap = get_remaining_cap_minutes
        self._is_active = is_active
        self._get_active_unlock = get_active_unlock
        self._get_free_pass_seconds = get_free_pass_seconds
        self._get_rate = get_consumption_rate_per_minute
        self._cap = daily_credit_cap
        self._enabled = True
        self._on_double_click = on_double_click

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
        self.setFixedSize(160, 82)
        self.setToolTip("双击打开状态面板; 按住可拖")

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

        # 第一行: token 图标 + 数字
        row1 = QHBoxLayout()
        row1.setSpacing(6)
        self._token_icon = QLabel(card)
        row1.addWidget(self._token_icon)
        self._token_label = QLabel("--", card)
        self._token_label.setObjectName("token")
        row1.addWidget(self._token_label, 1)
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
        self._token_icon.setPixmap(_icon_pixmap("fa5s.gem", COLOR_OK, 18))
        self._status_icon.setPixmap(_icon_pixmap("fa5s.clock", COLOR_TEXT_DIM))

    def _apply_color(self, accent: str) -> None:
        qss = f"""
        QWidget#card {{
            background-color: {COLOR_CARD_BG};
            border-radius: 12px;
            border: 1px solid {COLOR_BORDER};
        }}
        QLabel#token {{
            color: {accent};
            font-family: "Microsoft YaHei UI";
            font-size: 16pt;
            font-weight: bold;
        }}
        QLabel#status {{
            color: {COLOR_TEXT_DIM};
            font-family: "Microsoft YaHei UI";
            font-size: 9pt;
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
            rem_cap = int(self._get_remaining_cap())
            free_pass_secs = int(self._get_free_pass_seconds()) if self._get_free_pass_seconds else 0
            rate = float(self._get_rate()) if self._get_rate else 1.0
        except Exception:
            _log.exception("overlay refresh failed")
            return

        self._token_label.setText(str(balance))
        accent = _color_for_token(balance, self._cap)
        self._token_icon.setPixmap(_icon_pixmap("fa5s.gem", accent, 18))

        # 状态行 (优先级从高到低)
        unlock = None
        if self._get_active_unlock is not None:
            try:
                unlock = self._get_active_unlock()
            except Exception:
                _log.exception("get_active_unlock failed")

        category = info[0] if info else None

        if free_pass_secs > 0:
            mins = max(1, (free_pass_secs + 59) // 60)
            self._status_label.setText(f"限免中 · 剩 {mins} 分")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.gift", COLOR_GIFT))
            accent = COLOR_GIFT
        elif unlock is not None:
            _, secs = unlock
            mins_left = max(0, secs // 60)
            self._status_label.setText(f"已放行 {mins_left} 分钟")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.unlock", COLOR_OK))
            accent = COLOR_OK
        elif balance <= 0:
            self._status_label.setText("Token 已用完")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.exclamation-circle", COLOR_DANGER))
            accent = COLOR_DANGER
        else:
            # 默认显示"可玩 X 分钟" (基于 balance/rate, 但被 daily_cap 兜底)
            # 决策 #33 后任何 child 前台都会扣, 所以不再按 consumption 区分
            if rate <= 0:
                minutes_left = balance  # 退化
            else:
                minutes_left = int(balance / rate)
            minutes_left = max(0, min(minutes_left, rem_cap)) if rem_cap > 0 else max(0, minutes_left)
            if category == "consumption":
                self._status_label.setText(f"可玩 {minutes_left} 分钟")
            else:
                self._status_label.setText(f"还可用 {minutes_left} 分钟")
            self._status_icon.setPixmap(_icon_pixmap("fa5s.clock", accent))

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

    def mouseDoubleClickEvent(self, event) -> None:
        """双击 → 拉起状态面板 (孩子常用入口, 比找托盘快)."""
        if event.button() == Qt.LeftButton and self._on_double_click is not None:
            try:
                self._on_double_click()
            except Exception:
                _log.exception("on_double_click 回调失败")
            event.accept()
