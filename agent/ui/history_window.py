"""通用历史列表窗口 (托盘"我的消息..." / "查看余额变动..." 共用)。

由调用方传 fetch_rows + render_row 决定数据来源与展示样式。
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
    QScrollArea,
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
COLOR_WARN = "#d63b3b"
COLOR_CLOSE_HOVER = "#d63b3b"


class HistoryWindow(QWidget):
    """通用列表窗口。

    fetch_rows() -> list[dict]: 任何形态, 由 render_row 翻译为 QWidget
    render_row(parent, row) -> QWidget: 单行渲染
    """

    def __init__(
        self,
        title: str,
        fetch_rows: Callable[[], list[dict]],
        render_row: Callable[[QWidget, dict], QWidget],
        empty_text: str = "暂无记录",
        logo_path: str | Path | None = None,
    ) -> None:
        super().__init__()
        self._title_text = title
        self._fetch_rows = fetch_rows
        self._render_row = render_row
        self._empty_text = empty_text
        self._logo_path = str(logo_path) if logo_path else None

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(500, 520)
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

        # Header
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
        title = QLabel(self._title_text, header)
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

        # Body
        body = QWidget(card)
        bl = QVBoxLayout(body)
        bl.setContentsMargins(16, 12, 16, 12)
        bl.setSpacing(8)

        # 列表
        self._scroll = QScrollArea(body)
        self._scroll.setWidgetResizable(True)
        self._scroll.setObjectName("scroll")
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._list_host = QWidget()
        self._list_layout = QVBoxLayout(self._list_host)
        self._list_layout.setContentsMargins(0, 0, 0, 0)
        self._list_layout.setSpacing(4)
        self._scroll.setWidget(self._list_host)
        bl.addWidget(self._scroll, 1)

        # Footer
        bottom = QHBoxLayout()
        bottom.addStretch(1)
        refresh_btn = QPushButton(body)
        refresh_btn.setObjectName("ghost")
        refresh_btn.setCursor(Qt.PointingHandCursor)
        refresh_btn.setIcon(qta.icon("fa5s.sync", color=COLOR_TEXT_DIM))
        refresh_btn.setIconSize(QSize(13, 13))
        refresh_btn.setText("  刷新")
        refresh_btn.clicked.connect(self.reload)
        bottom.addWidget(refresh_btn)
        close2 = QPushButton("关闭", body)
        close2.setObjectName("ghost")
        close2.setCursor(Qt.PointingHandCursor)
        close2.clicked.connect(self.hide)
        bottom.addWidget(close2)
        bl.addLayout(bottom)

        cl.addWidget(body, 1)

        self.setStyleSheet(f"""
        QWidget#card {{ background-color: {COLOR_CARD}; border-radius: 14px; }}
        QFrame#header {{ background-color: {COLOR_PRIMARY};
            border-top-left-radius: 14px; border-top-right-radius: 14px; }}
        QLabel#htitle {{ color: white; font-family: "Microsoft YaHei UI";
            font-size: 11pt; font-weight: bold; }}
        QScrollArea#scroll {{ border: 1px solid {COLOR_BORDER}; border-radius: 6px;
            background-color: {COLOR_BG}; }}
        QPushButton#ghost {{ background-color: transparent; color: {COLOR_TEXT_DIM};
            border: 1px solid {COLOR_BORDER}; border-radius: 6px; padding: 6px 14px;
            font-family: "Microsoft YaHei UI"; font-size: 9pt; }}
        QPushButton#ghost:hover {{ color: {COLOR_TEXT}; border-color: {COLOR_PRIMARY}; }}
        QPushButton#close {{ background-color: transparent; color: white;
            border: 0; font-size: 18pt; font-family: "Segoe UI Symbol"; }}
        QPushButton#close:hover {{ background-color: {COLOR_CLOSE_HOVER};
            border-top-right-radius: 14px; }}
        """)

    def reload(self) -> None:
        # 清空旧 children
        while self._list_layout.count():
            it = self._list_layout.takeAt(0)
            w = it.widget()
            if w is not None:
                w.deleteLater()
        try:
            rows = list(self._fetch_rows() or [])
        except Exception:
            _log.exception("fetch_rows failed")
            rows = []
        if not rows:
            empty = QLabel(self._empty_text, self._list_host)
            empty.setAlignment(Qt.AlignCenter)
            empty.setStyleSheet(
                f"color: {COLOR_TEXT_DIM}; font-family: 'Microsoft YaHei UI'; "
                f"font-size: 9pt; padding: 30px;"
            )
            empty.setWordWrap(True)
            self._list_layout.addWidget(empty)
            return
        for r in rows:
            try:
                w = self._render_row(self._list_host, r)
            except Exception:
                _log.exception("render_row failed for row=%r", r)
                continue
            self._list_layout.addWidget(w)
        self._list_layout.addStretch(1)

    def show_for_user(self) -> None:
        self.reload()
        self.show()
        self.raise_()
        self.activateWindow()

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


# ────────────────────────────────────────────────────────────────
# 行渲染器: 消息 / ledger
# ────────────────────────────────────────────────────────────────
def render_notification_row(parent: QWidget, row: dict) -> QWidget:
    """row: {level, title, body, created_at}"""
    level = row.get("level") or "info"
    icon_color = COLOR_WARN if level == "warn" else COLOR_PRIMARY
    return _make_card(
        parent,
        icon_name="fa5s.exclamation-triangle" if level == "warn" else "fa5s.info-circle",
        icon_color=icon_color,
        title=str(row.get("title") or ""),
        body=str(row.get("body") or ""),
        right_text="",
        right_color=COLOR_TEXT_DIM,
        time_text=_fmt_time(row.get("created_at")),
    )


REASON_LABELS = {
    "daily_grant": "每日发放",
    "parent_grant": "家长发奖",
    "task_reward": "任务奖励",
    "adjustment": "余额调整",
    "refund": "退款",
    "unlock_prepay": "申请预扣",
    "streak_bonus": "连续奖励",
    "server_sync": "余额同步",
    "app_consumption": "玩耍扣费",
    "path1_auto": "自动挣分",
}


def render_ledger_row(parent: QWidget, row: dict) -> QWidget:
    """row: {delta, balance_after, reason, ref_id, occurred_at}"""
    delta = int(row.get("delta") or 0)
    reason = str(row.get("reason") or "")
    ref = str(row.get("ref_id") or "").strip()
    pos = delta > 0
    return _make_card(
        parent,
        icon_name="fa5s.plus-circle" if pos else "fa5s.minus-circle",
        icon_color=COLOR_OK if pos else COLOR_WARN,
        title=REASON_LABELS.get(reason, reason or "—"),
        body=ref or " ",
        right_text=f"{'+' if pos else ''}{delta}",
        right_color=COLOR_OK if pos else COLOR_WARN,
        time_text=_fmt_time(row.get("occurred_at")),
        balance_text=f"余 {row.get('balance_after')}",
    )


def _make_card(
    parent: QWidget,
    *,
    icon_name: str,
    icon_color: str,
    title: str,
    body: str,
    right_text: str,
    right_color: str,
    time_text: str,
    balance_text: str = "",
) -> QWidget:
    row = QFrame(parent)
    row.setStyleSheet(
        f"QFrame {{ background-color: {COLOR_CARD}; border: 1px solid {COLOR_BORDER};"
        f" border-radius: 6px; }}"
    )
    rl = QHBoxLayout(row)
    rl.setContentsMargins(10, 8, 12, 8)
    rl.setSpacing(10)

    icon_lbl = QLabel(row)
    icon_lbl.setPixmap(qta.icon(icon_name, color=icon_color).pixmap(QSize(18, 18)))
    rl.addWidget(icon_lbl)

    box = QVBoxLayout()
    box.setSpacing(2)
    t = QLabel(title, row)
    t.setStyleSheet(
        f"color: {COLOR_TEXT}; font-family: 'Microsoft YaHei UI'; "
        f"font-size: 10pt; font-weight: bold; border: 0;"
    )
    box.addWidget(t)
    if body and body != " ":
        b = QLabel(body, row)
        b.setWordWrap(True)
        b.setStyleSheet(
            f"color: {COLOR_TEXT_DIM}; font-family: 'Microsoft YaHei UI'; "
            f"font-size: 9pt; border: 0;"
        )
        box.addWidget(b)
    bottom_text = time_text + (f"  ·  {balance_text}" if balance_text else "")
    if bottom_text:
        s = QLabel(bottom_text, row)
        s.setStyleSheet(
            f"color: #9aabb5; font-family: 'Microsoft YaHei UI'; "
            f"font-size: 8pt; border: 0;"
        )
        box.addWidget(s)
    rl.addLayout(box)
    rl.addStretch(1)

    if right_text:
        r = QLabel(right_text, row)
        r.setStyleSheet(
            f"color: {right_color}; font-family: 'Microsoft YaHei UI'; "
            f"font-size: 12pt; font-weight: bold; border: 0;"
        )
        rl.addWidget(r)

    return row


def _fmt_time(iso: str | None) -> str:
    if not iso:
        return ""
    from datetime import datetime
    try:
        # SQLite "YYYY-MM-DD HH:MM:SS" or ISO
        s = str(iso).replace("T", " ").split(".")[0]
        d = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        return d.strftime("%m-%d %H:%M")
    except Exception:
        return str(iso)
