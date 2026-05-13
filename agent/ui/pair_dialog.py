"""PySide6 配对对话框: 替代 CLI pair.py。

支持:
  - 一行粘贴魔法链接 "https://server/#pair=ABCDEFGH" 自动解析 URL + 码
  - 或分别输入 server URL + 8 位码

风格跟 PinDialog / StatusPanel 一致 (蓝 header + 圆角 + 阴影)。
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
    QLineEdit,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from comms.pairing import parse_magic_link, redeem_pair_code, save_pair_settings

_log = logging.getLogger(__name__)

# 跟 dialogs / panel 同配色
COLOR_PRIMARY = "#1ea7c4"
COLOR_PRIMARY_HOVER = "#1789a3"
COLOR_BG = "#f5f9fb"
COLOR_CARD = "#ffffff"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BORDER = "#dbe5eb"
COLOR_OK = "#5cb85c"
COLOR_WARN = "#d96a3c"
COLOR_CLOSE_HOVER = "#d63b3b"


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
QLabel#section {{
    color: {text};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
    font-weight: bold;
}}
QLabel#hint {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
}}
QLineEdit, QTextEdit {{
    border: 1px solid {border};
    border-radius: 6px;
    padding: 6px 10px;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
    color: {text};
    background-color: white;
}}
QLineEdit:focus, QTextEdit:focus {{
    border-color: {primary};
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
QPushButton#primary:hover {{ background-color: {primary_hover}; }}
QPushButton#primary:disabled {{ background-color: {border}; color: {text_dim}; }}
QPushButton#ghost {{
    background-color: transparent;
    color: {text_dim};
    border: 1px solid {border};
    border-radius: 6px;
    padding: 8px 18px;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QPushButton#ghost:hover {{ color: {text}; border-color: {primary}; }}
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
QLabel#status_ok {{
    color: {ok};
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
}}
QLabel#status_warn {{
    color: {warn};
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
}}
"""


class PairDialog(QWidget):
    """非模态配对对话框。

    用法:
        d = PairDialog(settings_path, on_done=cb)
        d.show()
    on_done(success: bool, server_url: str, agent_token: str) 在配对结束后回调。
    """

    def __init__(
        self,
        settings_path: str | Path,
        logo_path: str | Path | None = None,
        on_done: Callable[[bool, str, str], None] | None = None,
        current_url: str | None = None,
    ) -> None:
        super().__init__()
        self._settings_path = Path(settings_path)
        self._logo_path = str(logo_path) if logo_path else None
        self._on_done = on_done

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(440, 380)
        if self._logo_path and Path(self._logo_path).exists():
            self.setWindowIcon(QIcon(self._logo_path))

        self._drag_pos: QPoint | None = None
        self._build_ui(current_url or "")
        self._center_on_screen()

    def _build_ui(self, current_url: str) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 16, 16, 16)

        self._card = QWidget(self)
        self._card.setObjectName("card")
        outer.addWidget(self._card)

        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(28)
        shadow.setOffset(0, 4)
        shadow.setColor(QColor(0, 0, 0, 60))
        self._card.setGraphicsEffect(shadow)

        cl = QVBoxLayout(self._card)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(0)

        # Header (跟 panel.py 一致风格)
        header = QFrame(self._card)
        header.setObjectName("header")
        header.setFixedHeight(44)
        h = QHBoxLayout(header)
        h.setContentsMargins(14, 0, 0, 0)
        h.setSpacing(8)
        if self._logo_path and Path(self._logo_path).exists():
            logo = QLabel(header)
            logo.setPixmap(QPixmap(self._logo_path).scaled(24, 24, Qt.KeepAspectRatio, Qt.SmoothTransformation))
            h.addWidget(logo)
        title = QLabel("NinoGame · 配对家长后台", header)
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
        cl.addWidget(header)

        # Body
        body = QWidget(self._card)
        bl = QVBoxLayout(body)
        bl.setContentsMargins(24, 18, 24, 18)
        bl.setSpacing(10)

        intro = QLabel(
            "把家长后台「生成配对码」给你的链接粘贴下面任意一格，\n"
            "Agent 会自动识别 server 地址和配对码。",
            body,
        )
        intro.setObjectName("hint")
        intro.setWordWrap(True)
        bl.addWidget(intro)

        # 大输入框 (支持粘贴链接, 自动解析)
        bl.addSpacing(4)
        magic_label = QLabel("快速粘贴 (链接 或 8 位码)", body)
        magic_label.setObjectName("section")
        bl.addWidget(magic_label)
        self._magic_input = QTextEdit(body)
        self._magic_input.setPlaceholderText("https://ninogame.x.com/#pair=ABCDEFGH")
        self._magic_input.setFixedHeight(54)
        self._magic_input.textChanged.connect(self._on_magic_changed)
        bl.addWidget(self._magic_input)

        # 状态提示行
        self._magic_hint = QLabel("等待输入...", body)
        self._magic_hint.setObjectName("hint")
        bl.addWidget(self._magic_hint)

        bl.addSpacing(6)

        # 分项 (高级)
        sec = QLabel("或分别输入", body)
        sec.setObjectName("section")
        bl.addWidget(sec)

        url_row = QHBoxLayout()
        url_row.setSpacing(6)
        url_row.addWidget(QLabel("URL", body))
        self._url_input = QLineEdit(current_url, body)
        self._url_input.setPlaceholderText("http://127.0.0.1:8088")
        url_row.addWidget(self._url_input, 1)
        bl.addLayout(url_row)

        code_row = QHBoxLayout()
        code_row.setSpacing(6)
        code_row.addWidget(QLabel("码", body))
        self._code_input = QLineEdit(body)
        self._code_input.setPlaceholderText("ABCDEFGH")
        self._code_input.setMaxLength(16)
        code_row.addWidget(self._code_input, 1)
        bl.addLayout(code_row)

        # 状态 + 按钮
        bl.addSpacing(8)
        self._status_label = QLabel("", body)
        self._status_label.setObjectName("hint")
        self._status_label.setWordWrap(True)
        bl.addWidget(self._status_label)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        cancel = QPushButton("取消", body)
        cancel.setObjectName("ghost")
        cancel.setCursor(Qt.PointingHandCursor)
        cancel.clicked.connect(self.hide)
        btn_row.addWidget(cancel)
        self._submit_btn = QPushButton(body)
        self._submit_btn.setObjectName("primary")
        self._submit_btn.setCursor(Qt.PointingHandCursor)
        self._submit_btn.setIcon(qta.icon("fa5s.link", color="white"))
        self._submit_btn.setIconSize(QSize(14, 14))
        self._submit_btn.setText("  开始配对")
        self._submit_btn.clicked.connect(self._on_submit)
        btn_row.addWidget(self._submit_btn)
        bl.addLayout(btn_row)

        cl.addWidget(body, 1)

        self.setStyleSheet(_QSS.format(
            card=COLOR_CARD, primary=COLOR_PRIMARY, primary_hover=COLOR_PRIMARY_HOVER,
            text=COLOR_TEXT, text_dim=COLOR_TEXT_DIM, border=COLOR_BORDER,
            ok=COLOR_OK, warn=COLOR_WARN, close_hover=COLOR_CLOSE_HOVER,
        ))

    def _center_on_screen(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        g = screen.availableGeometry()
        x = g.x() + (g.width() - self.width()) // 2
        y = g.y() + (g.height() - self.height()) // 3
        self.move(x, y)

    def _header_press(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def _header_move(self, event) -> None:
        if self._drag_pos is not None and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            event.accept()

    # ── 输入处理 ────────────────────────────────────────────────
    def _on_magic_changed(self) -> None:
        text = self._magic_input.toPlainText()
        if not text.strip():
            self._magic_hint.setText("等待输入...")
            return
        pp = parse_magic_link(text)
        if pp.server_url:
            self._url_input.setText(pp.server_url)
        if pp.code:
            self._code_input.setText(pp.code)
        msg = []
        if pp.server_url:
            msg.append(f"URL: {pp.server_url}")
        if pp.code:
            msg.append(f"码: {pp.code}")
        if msg:
            self._magic_hint.setText("✓ " + " · ".join(msg))
        else:
            self._magic_hint.setText("无法识别, 请用下面分项输入")

    def _on_submit(self) -> None:
        url = self._url_input.text().strip().rstrip("/")
        code = self._code_input.text().strip().upper()

        if not url or not code:
            self._show_status("URL 和 码 都不能为空", ok=False)
            return
        if len(code) < 6:
            self._show_status(f"码长度不对 ({len(code)} 位)", ok=False)
            return

        self._submit_btn.setEnabled(False)
        self._show_status("连接中...", ok=True)
        QApplication.processEvents()

        try:
            result = redeem_pair_code(url, code)
        except RuntimeError as e:
            self._show_status(f"× 兑换失败: {e}", ok=False)
            self._submit_btn.setEnabled(True)
            return

        token = result.get("agent_token")
        if not token:
            self._show_status(f"× 后端返回缺 agent_token: {result}", ok=False)
            self._submit_btn.setEnabled(True)
            return

        try:
            save_pair_settings(
                self._settings_path,
                url,
                token,
                result.get("device_id"),
                result.get("child_id"),
            )
        except Exception:
            _log.exception("save_pair_settings failed")
            self._show_status("× settings.json 写入失败", ok=False)
            self._submit_btn.setEnabled(True)
            return

        self._show_status(
            f"✓ 配对成功! device_id={result.get('device_id')}\n"
            f"请重启 Agent 以连接新 server。",
            ok=True,
        )
        if self._on_done is not None:
            try:
                self._on_done(True, url, token)
            except Exception:
                pass

    def _show_status(self, text: str, *, ok: bool) -> None:
        self._status_label.setText(text)
        self._status_label.setObjectName("status_ok" if ok else "status_warn")
        # 重设 stylesheet 让 objectName 生效
        self._status_label.style().unpolish(self._status_label)
        self._status_label.style().polish(self._status_label)
