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
from PySide6.QtGui import QColor, QPixmap, QIcon, QTextCursor
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
        on_submit: Callable[[str], "tuple[bool, str] | bool"] | None = None,
        get_transport_warning: Callable[[], str | None] | None = None,
        get_quick_options: Callable[[], list[str]] | None = None,
    ) -> None:
        """get_quick_options: 返回当前快捷选项 list (家长后台配, settings_update 推送).
        每次 show() 重渲染 chip 区, 设置改了立刻生效."""
        super().__init__()
        self._logo_path = str(logo_path) if logo_path else None
        self._on_submit = on_submit
        self._get_transport_warning = get_transport_warning
        self._get_quick_options = get_quick_options
        # 关闭后的一次性回调 (外部赋值); hide/close 触发后清零防止重入。
        # 用途: OutOfTokenDialog 锁屏态下弹 RequestDialog, 关掉时必须立刻
        # 把锁屏拉回, 否则孩子能点申请绕过锁。
        self.on_closed: Callable[[], None] | None = None

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

        # 配对状态横幅 (show() 时刷新)
        self._warning = QLabel("", body)
        self._warning.setWordWrap(True)
        self._warning.setVisible(False)
        self._warning.setStyleSheet(
            "background-color: #fff5e6; color: #b56500; border: 1px solid #ffd591;"
            " border-radius: 6px; padding: 8px 10px;"
            " font-family: 'Microsoft YaHei UI'; font-size: 9pt;"
        )
        bl.addWidget(self._warning)

        # 快捷选项 chips (不会打字的小孩点 chip 直接填进输入框)
        # 容器永远在, chips 在 show() 时根据 get_quick_options 动态重建
        self._chip_container = QWidget(body)
        self._chip_layout = QVBoxLayout(self._chip_container)
        self._chip_layout.setContentsMargins(0, 0, 0, 0)
        self._chip_layout.setSpacing(6)
        self._chip_container.setVisible(False)
        bl.addWidget(self._chip_container)

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

    def show(self) -> None:  # type: ignore[override]
        # 每次显示前刷新配对/连接状态横幅, 让孩子提前看到"现在能不能发出去"
        if self._get_transport_warning is not None:
            try:
                w = self._get_transport_warning()
                if w:
                    self._warning.setText("⚠ " + w)
                    self._warning.setVisible(True)
                else:
                    self._warning.setVisible(False)
            except Exception:
                _log.exception("get_transport_warning failed")
                self._warning.setVisible(False)
        else:
            self._warning.setVisible(False)
        self._rebuild_chips()
        super().show()

    def _rebuild_chips(self) -> None:
        """清空 chip 区, 拿最新的 quick_options 重渲染 (家长后台改后即时生效)."""
        # 清掉旧 chip
        while self._chip_layout.count():
            it = self._chip_layout.takeAt(0)
            w = it.widget() if it is not None else None
            if w is not None:
                w.deleteLater()
        options: list[str] = []
        if self._get_quick_options is not None:
            try:
                raw = self._get_quick_options() or []
                options = [str(s).strip() for s in raw if str(s).strip()]
            except Exception:
                _log.exception("get_quick_options failed")
                options = []
        if not options:
            self._chip_container.setVisible(False)
            return
        hint = QLabel("不会打字? 直接点下面的:", self._chip_container)
        hint.setStyleSheet(
            f"color: {COLOR_TEXT_DIM}; font-family: 'Microsoft YaHei UI';"
            f" font-size: 9pt; padding: 0;"
        )
        self._chip_layout.addWidget(hint)
        for opt in options:
            btn = QPushButton(opt, self._chip_container)
            btn.setCursor(Qt.PointingHandCursor)
            btn.setStyleSheet(
                f"QPushButton {{ background-color: {COLOR_BG}; color: {COLOR_TEXT};"
                f" border: 1px solid {COLOR_BORDER}; border-radius: 14px;"
                f" padding: 6px 14px; text-align: left;"
                f" font-family: 'Microsoft YaHei UI'; font-size: 10pt; }}"
                f" QPushButton:hover {{ border-color: {COLOR_PRIMARY};"
                f" color: {COLOR_PRIMARY}; background-color: white; }}"
            )
            # 闭包陷阱: 用默认参数捕获 opt
            btn.clicked.connect(lambda _checked=False, t=opt: self._fill_input(t))
            self._chip_layout.addWidget(btn)
        self._chip_container.setVisible(True)

    def _fill_input(self, text: str) -> None:
        """点 chip → 填到输入框, 光标放末尾, 孩子可以再添补."""
        self._input.setPlainText(text)
        self._input.moveCursor(QTextCursor.End)
        self._input.setFocus()

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
        _log.info("[RequestDialog] 发送按钮被点击")
        text = self._input.toPlainText().strip()
        if not text:
            self._set_status("× 请先输入想说的话", tone="warn")
            return
        if len(text) < 4:
            self._set_status("× 写一句完整的话呗 (至少 4 个字)", tone="warn")
            return
        self._send.setEnabled(False)
        self._set_status("发送中...", tone="info")
        QApplication.processEvents()
        ok = False
        msg = "发送失败"
        if self._on_submit is not None:
            try:
                result = self._on_submit(text)
                # 兼容: 旧版返回 bool, 新版返回 (bool, str)
                if isinstance(result, tuple) and len(result) == 2:
                    ok, msg = bool(result[0]), str(result[1])
                else:
                    ok = bool(result)
                    msg = "已发送" if ok else "发送失败, 看 agent.log"
            except Exception as e:
                _log.exception("on_submit failed")
                ok = False
                msg = f"内部错误: {e}"
        if ok:
            self._set_status(f"✓ {msg}", tone="ok")
            self._input.clear()
        else:
            self._set_status(f"× {msg}", tone="warn")
        self._send.setEnabled(True)

    def _set_status(self, text: str, tone: str = "info") -> None:
        """tone in {info, warn, ok}; 不同 tone 不同色显示。"""
        color = {
            "ok": COLOR_OK,
            "warn": COLOR_CLOSE_HOVER,
            "info": COLOR_TEXT_DIM,
        }.get(tone, COLOR_TEXT_DIM)
        self._status.setStyleSheet(
            f"color: {color}; font-family: 'Microsoft YaHei UI'; "
            f"font-size: 9pt; min-height: 36px; padding: 4px;"
        )
        self._status.setText(text)

    # ---- 关闭通知 ----------------------------------------------------------
    # hide / close / 销毁 都触发一次 on_closed; 防止重入用 _closed_fired flag.
    def _fire_on_closed(self) -> None:
        cb = self.on_closed
        if cb is None:
            return
        self.on_closed = None   # 一次性, 防重入
        try:
            cb()
        except Exception:
            _log.exception("[RequestDialog] on_closed 回调失败")

    def hideEvent(self, event) -> None:  # type: ignore[override]
        super().hideEvent(event)
        self._fire_on_closed()

    def closeEvent(self, event) -> None:  # type: ignore[override]
        super().closeEvent(event)
        self._fire_on_closed()
