"""更新日志对话框: 拉 backend `/api/changelog` (公开端点) 渲染 markdown。

v0.4.9 / v0.5.17+ 跨端 CHANGELOG 单一真相: CHANGELOG.md 在 repo 根, backend
docker-compose volume 挂进容器, admin/Android/Win agent 三端从同一个端点拉,
不维护多份漂移。

风格跟 AboutDialog / PairDialog / StatusPanel 一致 (蓝 header + 圆角 + 阴影).
渲染走 QTextBrowser.setMarkdown(), Qt 原生支持, 不引第三方 markdown 库。
"""
from __future__ import annotations

import json
import logging
import threading
import urllib.request
import urllib.error
from pathlib import Path

from PySide6.QtCore import Qt, QObject, Signal, QPoint
from PySide6.QtGui import QColor, QPixmap, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

_log = logging.getLogger(__name__)

COLOR_PRIMARY = "#1ea7c4"
COLOR_PRIMARY_HOVER = "#1789a3"
COLOR_CARD = "#ffffff"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BORDER = "#dbe5eb"
COLOR_CLOSE_HOVER = "#d63b3b"
COLOR_BODY_BG = "#f5f9fb"


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
QLabel#subtitle {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
}}
QLabel#status {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QTextBrowser#content {{
    background-color: {body_bg};
    color: {text};
    border: 1px solid {border};
    border-radius: 8px;
    padding: 12px;
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QPushButton#primary {{
    background-color: {primary};
    color: white;
    border: 0;
    border-radius: 6px;
    padding: 7px 16px;
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
    padding: 7px 16px;
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


class _ChangelogFetcher(QObject):
    """后台线程拉 /api/changelog, 完成后通过 Qt 信号回主线程。

    Qt 信号跨线程自动 queue, 不会撞主线程的 widget tree。"""
    done = Signal(str, str)  # (content, error_message); 其一为空

    def fetch(self, backend_url: str) -> None:
        threading.Thread(
            target=self._run, args=(backend_url,), daemon=True,
        ).start()

    def _run(self, backend_url: str) -> None:
        url = backend_url.rstrip("/") + "/api/changelog"
        try:
            req = urllib.request.Request(
                url, headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8")
                data = json.loads(body)
                content = data.get("content", "") if isinstance(data, dict) else ""
                if not content:
                    self.done.emit("", "服务端返回空内容")
                    return
                self.done.emit(content, "")
        except urllib.error.HTTPError as e:
            self.done.emit("", f"HTTP {e.code}")
        except urllib.error.URLError as e:
            self.done.emit("", f"网络错误: {e.reason}")
        except Exception as e:  # noqa: BLE001
            _log.exception("拉 /api/changelog 失败")
            self.done.emit("", str(e))


class ChangelogDialog(QWidget):
    """无模态; show()/hide() 复用。"""

    def __init__(
        self,
        logo_path: str | Path | None,
        backend_url: str,
    ) -> None:
        super().__init__()
        self._logo_path = str(logo_path) if logo_path else None
        self._backend_url = backend_url
        self._fetcher = _ChangelogFetcher()
        self._fetcher.done.connect(self._on_fetched)

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint,
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(560, 560)

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

        title = QLabel("更新日志", header)
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

        body = QWidget(card)
        bl = QVBoxLayout(body)
        bl.setContentsMargins(22, 18, 22, 18)
        bl.setSpacing(10)

        subtitle = QLabel(
            "三端 (Admin / Android / Windows Agent) 共享同一份变更记录, "
            "从 backend 拉取实时数据。",
            body,
        )
        subtitle.setObjectName("subtitle")
        subtitle.setWordWrap(True)
        bl.addWidget(subtitle)

        self._status = QLabel("正在加载…", body)
        self._status.setObjectName("status")
        bl.addWidget(self._status)

        self._browser = QTextBrowser(body)
        self._browser.setObjectName("content")
        self._browser.setOpenExternalLinks(True)
        self._browser.setVisible(False)
        bl.addWidget(self._browser, 1)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        btn_row.addStretch(1)
        self._refresh_btn = QPushButton("刷新", body)
        self._refresh_btn.setObjectName("ghost")
        self._refresh_btn.setCursor(Qt.PointingHandCursor)
        self._refresh_btn.clicked.connect(self._do_fetch)
        btn_row.addWidget(self._refresh_btn)
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
                body_bg=COLOR_BODY_BG,
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

    def _do_fetch(self) -> None:
        if not self._backend_url:
            self._status.setText("未配对, 拿不到 backend URL — 请先完成设备配对")
            self._browser.setVisible(False)
            return
        self._status.setText("正在加载…")
        self._browser.setVisible(False)
        self._refresh_btn.setEnabled(False)
        self._fetcher.fetch(self._backend_url)

    def _on_fetched(self, content: str, err: str) -> None:
        self._refresh_btn.setEnabled(True)
        if err:
            self._status.setText(f"加载失败: {err}")
            self._browser.setVisible(False)
            return
        self._status.setText("")
        self._browser.setMarkdown(content)
        self._browser.setVisible(True)
        # 顶部对齐, 用户进来看最新
        cursor = self._browser.textCursor()
        cursor.movePosition(cursor.MoveOperation.Start)
        self._browser.setTextCursor(cursor)

    def update_backend_url(self, backend_url: str) -> None:
        """重新配对后 backend_url 变了, 让外部更新进来。"""
        self._backend_url = backend_url

    def show_dialog(self) -> None:
        self.show()
        self.raise_()
        self.activateWindow()
        self._do_fetch()
