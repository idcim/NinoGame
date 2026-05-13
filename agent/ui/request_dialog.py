"""孩子端「申请游戏时间」对话框 (CLAUDE.md §13.1)。

简易模式 (LLM 翻译留给 P3):
  孩子自然语言写"我作业写完了想玩半小时 PvZ"
  Agent 通过 WS 发 unlock_request → server 转家长浏览器
  家长在 /requests 页一键批准 → 自动 push temporary_unlock
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

import qtawesome as qta
from PySide6.QtCore import Qt, QSize, QPoint
from PySide6.QtGui import QColor, QPixmap, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

_log = logging.getLogger(__name__)

COLOR_PRIMARY = "#1ea7c4"
COLOR_PRIMARY_HOVER = "#1789a3"
COLOR_BG = "#f5f9fb"
COLOR_CARD = "#ffffff"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BORDER = "#dbe5eb"
COLOR_OK = "#5cb85c"
COLOR_CLOSE_HOVER = "#d63b3b"


class RequestDialog(QWidget):
    """提交 unlock_request 的对话框。

    on_submit(text) 由调用方实现 — 通常是 main.py 拿 text 包成
    {type:"unlock_request", payload:{request_text}} 发给 transport。
    """

    def __init__(
        self,
        logo_path: str | Path | None = None,
        on_submit: Callable[[str], bool] | None = None,
    ) -> None:
        super().__init__()
        self._logo_path = str(logo_path) if logo_path else None
        self._on_submit = on_submit

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(440, 380)
        if self._logo_path and Path(self._logo_path).exists():
            self.setWindowIcon(QIcon(self._logo_path))
        self._drag_pos: QPoint | None = None

        self._build()
        self._center()

    def _build(self) -> None:
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

        cl = QVBoxLayout(card)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(0)

        header = QFrame(card)
        header.setObjectName("header")
        header.setFixedHeight(44)
        h = QHBoxLayout(header)
        h.setContentsMargins(14, 0, 0, 0)
        h.setSpacing(8)
        if self._logo_path and Path(self._logo_path).exists():
            ic = QLabel(header)
            ic.setPixmap(
                QPixmap(self._logo_path).scaled(
                    24, 24, Qt.KeepAspectRatio, Qt.SmoothTransformation,
                )
            )
            h.addWidget(ic)
        title = QLabel("NinoGame · 申请游戏时间", header)
        title.setObjectName("htitle")
        h.addWidget(title)
        h.addStretch(1)
        close_btn = QPushButton("×", header)
        close_btn.setObjectName("close")
        close_btn.setFixedSize(46, 44)
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.clicked.connect(self.hide)
        h.addWidget(close_btn)
        header.mousePressEvent = self._press
        header.mouseMoveEvent = self._move
        cl.addWidget(header)

        body = QWidget(card)
        bl = QVBoxLayout(body)
        bl.setContentsMargins(24, 18, 24, 18)
        bl.setSpacing(12)

        intro = QLabel(
            "用一句话告诉爸爸/妈妈你想做什么。\n"
            "例: 我作业写完了, 想玩 30 分钟 PvZ",
            body,
        )
        intro.setObjectName("hint")
        intro.setWordWrap(True)
        bl.addWidget(intro)

        self._input = QTextEdit(body)
        self._input.setPlaceholderText("我...")
        self._input.setFixedHeight(120)
        bl.addWidget(self._input)

        self._status = QLabel("", body)
        self._status.setObjectName("hint")
        bl.addWidget(self._status)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        cancel = QPushButton("取消", body)
        cancel.setObjectName("ghost")
        cancel.setCursor(Qt.PointingHandCursor)
        cancel.clicked.connect(self.hide)
        btn_row.addWidget(cancel)
        self._send = QPushButton(body)
        self._send.setObjectName("primary")
        self._send.setCursor(Qt.PointingHandCursor)
        self._send.setIcon(qta.icon("fa5s.paper-plane", color="white"))
        self._send.setIconSize(QSize(14, 14))
        self._send.setText("  发送给家长")
        self._send.clicked.connect(self._on_send)
        btn_row.addWidget(self._send)
        bl.addLayout(btn_row)

        cl.addWidget(body, 1)

        self.setStyleSheet(f"""
        QWidget#card {{ background-color: {COLOR_CARD}; border-radius: 14px; }}
        QFrame#header {{ background-color: {COLOR_PRIMARY};
            border-top-left-radius: 14px; border-top-right-radius: 14px; }}
        QLabel#htitle {{ color: white; font-family: "Microsoft YaHei UI";
            font-size: 11pt; font-weight: bold; }}
        QLabel#hint {{ color: {COLOR_TEXT_DIM}; font-family: "Microsoft YaHei UI";
            font-size: 9pt; }}
        QTextEdit {{ border: 1px solid {COLOR_BORDER}; border-radius: 6px;
            padding: 8px; font-family: "Microsoft YaHei UI"; font-size: 10pt;
            color: {COLOR_TEXT}; background-color: white; }}
        QTextEdit:focus {{ border-color: {COLOR_PRIMARY}; }}
        QPushButton#primary {{ background-color: {COLOR_PRIMARY}; color: white;
            border: 0; border-radius: 6px; padding: 8px 18px;
            font-family: "Microsoft YaHei UI"; font-size: 10pt; font-weight: bold; }}
        QPushButton#primary:hover {{ background-color: {COLOR_PRIMARY_HOVER}; }}
        QPushButton#primary:disabled {{ background-color: {COLOR_BORDER}; color: {COLOR_TEXT_DIM}; }}
        QPushButton#ghost {{ background-color: transparent; color: {COLOR_TEXT_DIM};
            border: 1px solid {COLOR_BORDER}; border-radius: 6px; padding: 8px 18px;
            font-family: "Microsoft YaHei UI"; font-size: 10pt; }}
        QPushButton#ghost:hover {{ color: {COLOR_TEXT}; border-color: {COLOR_PRIMARY}; }}
        QPushButton#close {{ background-color: transparent; color: white;
            border: 0; font-size: 18pt; font-family: "Segoe UI Symbol"; }}
        QPushButton#close:hover {{ background-color: {COLOR_CLOSE_HOVER};
            border-top-right-radius: 14px; }}
        """)

    def _center(self) -> None:
        s = QApplication.primaryScreen()
        if s is None:
            return
        g = s.availableGeometry()
        self.move(
            g.x() + (g.width() - self.width()) // 2,
            g.y() + (g.height() - self.height()) // 3,
        )

    def _press(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def _move(self, event) -> None:
        if self._drag_pos is not None and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            event.accept()

    def _on_send(self) -> None:
        text = self._input.toPlainText().strip()
        if not text:
            self._status.setText("× 请先输入想说的话")
            return
        self._send.setEnabled(False)
        self._status.setText("发送中...")
        QApplication.processEvents()
        ok = False
        if self._on_submit is not None:
            try:
                ok = bool(self._on_submit(text))
            except Exception:
                _log.exception("on_submit failed")
                ok = False
        if ok:
            self._status.setText(
                "✓ 已发送给家长。批准后浏览器会推命令过来, "
                "你可以等通知, 或先去做别的事。",
            )
            self._input.clear()
        else:
            self._status.setText(
                "× 发送失败 — 检查 Agent 是否已配对 + WebSocket 是否连上。",
            )
        self._send.setEnabled(True)
