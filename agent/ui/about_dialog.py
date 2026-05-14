"""About 对话框: 介绍 NinoGame 项目 (托盘菜单 / 状态面板 入口都能拉起)。

风格跟 PairDialog / StatusPanel 一致 (蓝 header + 圆角 + 阴影).
"""
from __future__ import annotations

import logging
import webbrowser
from pathlib import Path

from PySide6.QtCore import Qt, QSize, QPoint
from PySide6.QtGui import QColor, QPixmap, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

_log = logging.getLogger(__name__)

# 与其它对话框一致
COLOR_PRIMARY = "#1ea7c4"
COLOR_PRIMARY_HOVER = "#1789a3"
COLOR_CARD = "#ffffff"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BORDER = "#dbe5eb"
COLOR_CLOSE_HOVER = "#d63b3b"

PROJECT_NAME = "NinoGame"
PROJECT_TAGLINE = "家长控制 + 自我管理培养"
PROJECT_BLURB = (
    "一个能「逐步退场」的脚手架: 帮孩子在结构里学会自我管理,\n"
    "而不是把孩子永远关在系统里。\n\n"
    "Token = 屏幕时间, 可以挣、可以申请、可以协商。\n"
    "规则透明, 调账可见, 退出权交还给成长。"
)
PROJECT_URL = "https://github.com/idcim/NinoGame"


_QSS = """
QWidget#card {{
    background-color: {card};
    border-radius: 14px;
}}
QFrame#header {{
    background-color: {primary};
    border-top-left-radius: 14px;
    border-top-right-radius: 14px;
}}
QLabel#header_title {{
    color: white;
    font-family: "Microsoft YaHei UI";
    font-size: 11pt;
    font-weight: bold;
}}
QLabel#name {{
    color: {text};
    font-family: "Microsoft YaHei UI";
    font-size: 18pt;
    font-weight: bold;
}}
QLabel#tag {{
    color: {primary};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
    font-weight: bold;
}}
QLabel#version {{
    color: {text_dim};
    font-family: "Consolas", monospace;
    font-size: 9pt;
}}
QLabel#blurb {{
    color: {text};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QPushButton#primary {{
    background-color: {primary};
    color: white;
    border: 0;
    border-radius: 6px;
    padding: 8px 18px;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
    font-weight: bold;
}}
QPushButton#primary:hover {{
    background-color: {primary_hover};
}}
QPushButton#ghost {{
    background-color: transparent;
    color: {text_dim};
    border: 1px solid {border};
    border-radius: 6px;
    padding: 8px 18px;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QPushButton#ghost:hover {{
    color: {text};
    border-color: {primary};
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
"""


class AboutDialog(QWidget):
    """无模态; show()/hide() 复用, 不 destroy。"""

    def __init__(self, logo_path: str | Path | None, version: str) -> None:
        super().__init__()
        self._logo_path = str(logo_path) if logo_path else None
        self._version = version

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(420, 380)

        if self._logo_path and Path(self._logo_path).exists():
            self.setWindowIcon(QIcon(self._logo_path))

        self._drag_pos: QPoint | None = None
        self._build_ui()
        self._center_on_screen()

    def _build_ui(self) -> None:
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

        # Header
        header = QFrame(card)
        header.setObjectName("header")
        header.setFixedHeight(44)
        h = QHBoxLayout(header)
        h.setContentsMargins(14, 0, 0, 0)
        h.setSpacing(8)

        if self._logo_path and Path(self._logo_path).exists():
            logo = QLabel(header)
            pm = QPixmap(self._logo_path).scaled(
                24, 24, Qt.KeepAspectRatio, Qt.SmoothTransformation,
            )
            logo.setPixmap(pm)
            h.addWidget(logo)

        title = QLabel("关于 NinoGame", header)
        title.setObjectName("header_title")
        h.addWidget(title)
        h.addStretch(1)

        close_btn = QPushButton("×", header)
        close_btn.setObjectName("close")
        close_btn.setFixedSize(46, 44)
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.clicked.connect(self.hide)
        h.addWidget(close_btn)

        header.mousePressEvent = self._header_press
        header.mouseMoveEvent = self._header_move
        header.setCursor(Qt.SizeAllCursor)
        cl.addWidget(header)

        # Body
        body = QWidget(card)
        bl = QVBoxLayout(body)
        bl.setContentsMargins(28, 22, 28, 22)
        bl.setSpacing(10)

        # Logo 大图
        if self._logo_path and Path(self._logo_path).exists():
            big = QLabel(body)
            pm = QPixmap(self._logo_path).scaled(
                72, 72, Qt.KeepAspectRatio, Qt.SmoothTransformation,
            )
            big.setPixmap(pm)
            big.setAlignment(Qt.AlignCenter)
            bl.addWidget(big)

        name = QLabel(PROJECT_NAME, body)
        name.setObjectName("name")
        name.setAlignment(Qt.AlignCenter)
        bl.addWidget(name)

        tag = QLabel(PROJECT_TAGLINE, body)
        tag.setObjectName("tag")
        tag.setAlignment(Qt.AlignCenter)
        bl.addWidget(tag)

        ver = QLabel(f"version {self._version}", body)
        ver.setObjectName("version")
        ver.setAlignment(Qt.AlignCenter)
        bl.addWidget(ver)

        bl.addSpacing(6)

        blurb = QLabel(PROJECT_BLURB, body)
        blurb.setObjectName("blurb")
        blurb.setAlignment(Qt.AlignCenter)
        blurb.setWordWrap(True)
        bl.addWidget(blurb)

        bl.addStretch(1)

        # 按钮区
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        btn_row.addStretch(1)
        repo_btn = QPushButton("打开项目主页", body)
        repo_btn.setObjectName("ghost")
        repo_btn.setCursor(Qt.PointingHandCursor)
        repo_btn.clicked.connect(self._open_repo)
        btn_row.addWidget(repo_btn)
        ok_btn = QPushButton("好的", body)
        ok_btn.setObjectName("primary")
        ok_btn.setCursor(Qt.PointingHandCursor)
        ok_btn.clicked.connect(self.hide)
        btn_row.addWidget(ok_btn)
        bl.addLayout(btn_row)

        cl.addWidget(body, 1)

        self.setStyleSheet(
            _QSS.format(
                card=COLOR_CARD,
                primary=COLOR_PRIMARY,
                primary_hover=COLOR_PRIMARY_HOVER,
                text=COLOR_TEXT,
                text_dim=COLOR_TEXT_DIM,
                border=COLOR_BORDER,
                close_hover=COLOR_CLOSE_HOVER,
            ),
        )

    def _center_on_screen(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        x = geo.x() + (geo.width() - self.width()) // 2
        y = geo.y() + (geo.height() - self.height()) // 3
        self.move(x, y)

    def _header_press(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def _header_move(self, event) -> None:
        if self._drag_pos is not None and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            event.accept()

    def _open_repo(self) -> None:
        try:
            webbrowser.open(PROJECT_URL)
        except Exception:
            _log.exception("打开仓库链接失败")

    def show_dialog(self) -> None:
        self.show()
        self.raise_()
        self.activateWindow()
