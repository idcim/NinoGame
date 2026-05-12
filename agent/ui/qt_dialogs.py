"""PySide6 弹窗 (替代 Tkinter 版本)。

设计要点:
  - 全部在主线程（QApplication）创建，避免 pystray 工作线程的焦点坑
  - 无边框 + 阴影 + 圆角，标题栏自绘成 logo 蓝
  - QSS 取自 logo 配色
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

from PySide6.QtCore import Qt, QTimer, QSize, QEvent, QPoint
from PySide6.QtGui import QPixmap, QFont, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtGui import QColor

_log = logging.getLogger(__name__)

# 配色（与 logo 一致）
COLOR_PRIMARY = "#1ea7c4"
COLOR_PRIMARY_HOVER = "#1789a3"
COLOR_ACCENT = "#66c596"
COLOR_BG = "#f5f9fb"
COLOR_CARD = "#ffffff"
COLOR_WARN = "#d96a3c"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BORDER = "#dbe5eb"
COLOR_CLOSE_HOVER = "#d63b3b"

# 全局 QSS 模板
_QSS_TEMPLATE = """
QWidget#card {{
    background-color: {card};
    border-radius: 14px;
}}
QFrame#header {{
    background-color: {primary};
    border-top-left-radius: 14px;
    border-top-right-radius: 14px;
}}
QFrame#accent {{
    background-color: {accent};
    max-height: 4px;
    min-height: 4px;
}}
QLabel#title {{
    color: {text};
    font-family: "Microsoft YaHei UI";
    font-size: 14pt;
    font-weight: bold;
}}
QLabel#header_title {{
    color: white;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
    font-weight: bold;
}}
QLabel#prompt {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QLabel#message {{
    color: {text};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QLabel#countdown {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
}}
QPushButton#close {{
    background-color: transparent;
    color: white;
    border: 0;
    font-size: 18pt;
    font-family: "Segoe UI Symbol";
}}
QPushButton#close:hover {{
    background-color: {close_hover};
    border-top-right-radius: 14px;
}}
QPushButton#primary {{
    background-color: {primary};
    color: white;
    border: 0;
    border-radius: 6px;
    padding: 8px 24px;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
    font-weight: bold;
}}
QPushButton#primary:hover {{
    background-color: {primary_hover};
}}
QPushButton#primary:pressed {{
    background-color: {primary_hover};
}}
QPushButton#ghost {{
    background-color: transparent;
    color: {text_dim};
    border: 0;
    padding: 8px 20px;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QPushButton#ghost:hover {{
    color: {text};
}}
QLineEdit#pin {{
    border: 2px solid {border};
    border-radius: 6px;
    padding: 10px 12px;
    font-family: "Consolas";
    font-size: 16pt;
    background-color: white;
    color: {text};
    selection-background-color: {primary};
}}
QLineEdit#pin:focus {{
    border-color: {primary};
}}
QLabel#feedback {{
    color: {warn};
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
}}
"""


def _stylesheet() -> str:
    return _QSS_TEMPLATE.format(
        card=COLOR_CARD,
        primary=COLOR_PRIMARY,
        primary_hover=COLOR_PRIMARY_HOVER,
        accent=COLOR_ACCENT,
        text=COLOR_TEXT,
        text_dim=COLOR_TEXT_DIM,
        warn=COLOR_WARN,
        close_hover=COLOR_CLOSE_HOVER,
        border=COLOR_BORDER,
    )


def _load_pixmap(path: str | Path | None, size: int) -> QPixmap | None:
    if not path:
        return None
    p = Path(path)
    if not p.exists():
        return None
    px = QPixmap(str(p))
    if px.isNull():
        return None
    return px.scaled(size, size, Qt.KeepAspectRatio, Qt.SmoothTransformation)


# ────────────────────────────────────────────────────────────────
# 基类: 无边框 + 阴影 + 自绘 header
# ────────────────────────────────────────────────────────────────
class _CardDialog(QDialog):
    def __init__(
        self,
        header_title: str,
        logo_path: str | Path | None,
        accent_color: str = COLOR_ACCENT,
        width: int = 420,
        height: int = 320,
    ) -> None:
        super().__init__()
        self.setWindowFlags(
            Qt.Dialog
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_DeleteOnClose)
        self.setStyleSheet(_stylesheet())
        self.resize(width, height)

        # 设置任务栏 / Alt-Tab 图标
        if logo_path and Path(str(logo_path)).exists():
            self.setWindowIcon(QIcon(str(logo_path)))

        # 外层透明，内放一个 card 容器（带阴影）
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 16, 16, 16)

        card = QWidget(self)
        card.setObjectName("card")
        outer.addWidget(card)

        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(28)
        shadow.setOffset(0, 4)
        shadow.setColor(QColor(0, 0, 0, 60))
        card.setGraphicsEffect(shadow)

        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(0, 0, 0, 0)
        card_layout.setSpacing(0)

        # ── Header ────────────────────────────────────────────────
        header = QFrame(card)
        header.setObjectName("header")
        header.setFixedHeight(40)
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(12, 0, 0, 0)
        header_layout.setSpacing(8)

        if logo_path and Path(str(logo_path)).exists():
            small_logo = QLabel(header)
            pm = _load_pixmap(logo_path, 22)
            if pm is not None:
                small_logo.setPixmap(pm)
            header_layout.addWidget(small_logo)

        title_lbl = QLabel(header_title, header)
        title_lbl.setObjectName("header_title")
        header_layout.addWidget(title_lbl)
        header_layout.addStretch(1)

        close_btn = QPushButton("×", header)
        close_btn.setObjectName("close")
        close_btn.setFixedSize(46, 40)
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.clicked.connect(self.reject)
        header_layout.addWidget(close_btn)

        card_layout.addWidget(header)

        # Accent strip
        accent = QFrame(card)
        accent.setObjectName("accent")
        accent.setStyleSheet(f"background-color: {accent_color};")
        card_layout.addWidget(accent)

        # Body 容器（子类填）
        self._body = QWidget(card)
        body_layout = QVBoxLayout(self._body)
        body_layout.setContentsMargins(28, 22, 28, 22)
        body_layout.setSpacing(12)
        self._body_layout = body_layout
        card_layout.addWidget(self._body, 1)

        # Header 拖动支持
        self._drag_pos: QPoint | None = None
        header.mousePressEvent = self._header_press
        header.mouseMoveEvent = self._header_move

        # 居中
        self._center_on_screen()

    def _header_press(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def _header_move(self, event) -> None:
        if self._drag_pos is not None and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            event.accept()

    def _center_on_screen(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        x = geo.x() + (geo.width() - self.width()) // 2
        y = geo.y() + (geo.height() - self.height()) // 3
        self.move(x, y)

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key_Escape:
            self.reject()
            return
        super().keyPressEvent(event)


# ────────────────────────────────────────────────────────────────
# WarningDialog
# ────────────────────────────────────────────────────────────────
class WarningDialog(_CardDialog):
    def __init__(
        self,
        title: str,
        message: str,
        logo_path: str | Path | None = None,
        button_text: str = "我知道了",
        auto_close_seconds: int = 0,
        accent_color: str = COLOR_WARN,
    ) -> None:
        super().__init__(
            header_title=title,
            logo_path=logo_path,
            accent_color=accent_color,
            width=440,
            height=340,
        )

        # 大 logo
        pm = _load_pixmap(logo_path, 88)
        if pm is not None:
            big = QLabel(self._body)
            big.setPixmap(pm)
            big.setAlignment(Qt.AlignCenter)
            self._body_layout.addWidget(big)

        title_lbl = QLabel(title, self._body)
        title_lbl.setObjectName("title")
        title_lbl.setAlignment(Qt.AlignCenter)
        self._body_layout.addWidget(title_lbl)

        msg_lbl = QLabel(message, self._body)
        msg_lbl.setObjectName("message")
        msg_lbl.setAlignment(Qt.AlignCenter)
        msg_lbl.setWordWrap(True)
        self._body_layout.addWidget(msg_lbl)

        self._body_layout.addStretch(1)

        # 按钮
        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        btn = QPushButton(button_text, self._body)
        btn.setObjectName("primary")
        btn.setCursor(Qt.PointingHandCursor)
        btn.clicked.connect(self.accept)
        btn.setDefault(True)
        btn_row.addWidget(btn)
        btn_row.addStretch(1)
        self._body_layout.addLayout(btn_row)

        # 倒计时
        self._countdown_label: QLabel | None = None
        if auto_close_seconds > 0:
            self._remaining = auto_close_seconds
            self._countdown_label = QLabel("", self._body)
            self._countdown_label.setObjectName("countdown")
            self._countdown_label.setAlignment(Qt.AlignCenter)
            self._body_layout.addWidget(self._countdown_label)
            self._timer = QTimer(self)
            self._timer.timeout.connect(self._tick)
            self._timer.start(1000)
            self._tick()

    def _tick(self) -> None:
        if self._countdown_label is None:
            return
        if self._remaining <= 0:
            self.accept()
            return
        self._countdown_label.setText(f"{self._remaining} 秒后自动关闭")
        self._remaining -= 1


# ────────────────────────────────────────────────────────────────
# PinDialog
# ────────────────────────────────────────────────────────────────
class PinDialog(_CardDialog):
    def __init__(
        self,
        title: str,
        prompt: str,
        logo_path: str | Path | None,
        verify: Callable[[str], bool],
        on_wrong: Callable[[int], str],
        on_locked: Callable[[int], str],
        is_locked: Callable[[], bool],
        seconds_until_unlock: Callable[[], int],
        max_attempts: int = 3,
        confirm_text: str = "确认",
        cancel_text: str = "取消",
    ) -> None:
        super().__init__(
            header_title=title,
            logo_path=logo_path,
            accent_color=COLOR_ACCENT,
            width=420,
            height=380,
        )

        self._verify = verify
        self._on_wrong = on_wrong
        self._on_locked = on_locked
        self._is_locked = is_locked
        self._seconds_until_unlock = seconds_until_unlock
        self._max_attempts = max_attempts
        self.result_ok = False

        pm = _load_pixmap(logo_path, 80)
        if pm is not None:
            big = QLabel(self._body)
            big.setPixmap(pm)
            big.setAlignment(Qt.AlignCenter)
            self._body_layout.addWidget(big)

        title_lbl = QLabel(title, self._body)
        title_lbl.setObjectName("title")
        title_lbl.setAlignment(Qt.AlignCenter)
        self._body_layout.addWidget(title_lbl)

        prompt_lbl = QLabel(prompt, self._body)
        prompt_lbl.setObjectName("prompt")
        prompt_lbl.setAlignment(Qt.AlignCenter)
        prompt_lbl.setWordWrap(True)
        self._body_layout.addWidget(prompt_lbl)

        self._pin_input = QLineEdit(self._body)
        self._pin_input.setObjectName("pin")
        self._pin_input.setEchoMode(QLineEdit.Password)
        self._pin_input.setAlignment(Qt.AlignCenter)
        self._pin_input.setMaxLength(32)
        self._pin_input.returnPressed.connect(self._on_confirm)
        self._body_layout.addWidget(self._pin_input)

        self._feedback = QLabel("", self._body)
        self._feedback.setObjectName("feedback")
        self._feedback.setAlignment(Qt.AlignCenter)
        self._body_layout.addWidget(self._feedback)

        self._body_layout.addStretch(1)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        cancel_btn = QPushButton(cancel_text, self._body)
        cancel_btn.setObjectName("ghost")
        cancel_btn.setCursor(Qt.PointingHandCursor)
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        confirm_btn = QPushButton(confirm_text, self._body)
        confirm_btn.setObjectName("primary")
        confirm_btn.setCursor(Qt.PointingHandCursor)
        confirm_btn.clicked.connect(self._on_confirm)
        confirm_btn.setDefault(True)
        btn_row.addWidget(confirm_btn)
        btn_row.addStretch(1)
        self._body_layout.addLayout(btn_row)

        # 显示后立刻让 Entry 拿焦点 (showEvent 中再做一次兜底)
        QTimer.singleShot(0, self._pin_input.setFocus)

        # 初始锁状态
        self._refresh_lock_state(cancel_btn, confirm_btn)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        # 显示后强制激活 (跨线程 invoke 来的窗口需要)
        self.raise_()
        self.activateWindow()
        self._pin_input.setFocus(Qt.OtherFocusReason)

    def _refresh_lock_state(self, cancel_btn, confirm_btn) -> None:
        if self._is_locked():
            mins = max(1, self._seconds_until_unlock() // 60)
            self._feedback.setText(self._on_locked(mins))
            self._pin_input.setEnabled(False)
            confirm_btn.setEnabled(False)

    def _on_confirm(self) -> None:
        pin = self._pin_input.text().strip()
        if not pin:
            self._feedback.setText("请输入 PIN")
            return
        if self._is_locked():
            mins = max(1, self._seconds_until_unlock() // 60)
            self._feedback.setText(self._on_locked(mins))
            return
        if self._verify(pin):
            self.result_ok = True
            self.accept()
            return
        # 错误
        if self._is_locked():
            mins = max(1, self._seconds_until_unlock() // 60)
            self._feedback.setText(self._on_locked(mins))
        else:
            self._feedback.setText(self._on_wrong(self._max_attempts))
        self._pin_input.clear()
        self._pin_input.setFocus()


# ────────────────────────────────────────────────────────────────
# ConfirmDialog
# ────────────────────────────────────────────────────────────────
class ConfirmDialog(_CardDialog):
    def __init__(
        self,
        title: str,
        message: str,
        logo_path: str | Path | None,
        confirm_text: str = "确认",
        cancel_text: str = "取消",
        accent_color: str = COLOR_PRIMARY,
    ) -> None:
        super().__init__(
            header_title=title,
            logo_path=logo_path,
            accent_color=accent_color,
            width=420,
            height=320,
        )

        pm = _load_pixmap(logo_path, 72)
        if pm is not None:
            big = QLabel(self._body)
            big.setPixmap(pm)
            big.setAlignment(Qt.AlignCenter)
            self._body_layout.addWidget(big)

        title_lbl = QLabel(title, self._body)
        title_lbl.setObjectName("title")
        title_lbl.setAlignment(Qt.AlignCenter)
        self._body_layout.addWidget(title_lbl)

        msg_lbl = QLabel(message, self._body)
        msg_lbl.setObjectName("message")
        msg_lbl.setAlignment(Qt.AlignCenter)
        msg_lbl.setWordWrap(True)
        self._body_layout.addWidget(msg_lbl)

        self._body_layout.addStretch(1)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        cancel_btn = QPushButton(cancel_text, self._body)
        cancel_btn.setObjectName("ghost")
        cancel_btn.setCursor(Qt.PointingHandCursor)
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        confirm_btn = QPushButton(confirm_text, self._body)
        confirm_btn.setObjectName("primary")
        confirm_btn.setCursor(Qt.PointingHandCursor)
        confirm_btn.clicked.connect(self.accept)
        confirm_btn.setDefault(True)
        btn_row.addWidget(confirm_btn)
        btn_row.addStretch(1)
        self._body_layout.addLayout(btn_row)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        self.raise_()
        self.activateWindow()
