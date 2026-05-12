"""StatusPanel: 托盘双击弹出的状态总览面板 (CLAUDE.md §15.4 雏形)。

展示:
  - 当前余额 (大号)
  - 当前模式
  - 今日消费分钟 / 赚到 token / 完成任务
  - 操作按钮: 锁定 / 解锁 / 关闭面板

完整 Dashboard 留给 P2 + Web UI。这里只做"扫一眼能看到状态"的入口。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

import qtawesome as qta
from PySide6.QtCore import Qt, QSize, QTimer, QPoint, Slot
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
    QGridLayout,
)

_log = logging.getLogger(__name__)

# 同 dialogs / overlay 的配色
COLOR_PRIMARY = "#1ea7c4"
COLOR_PRIMARY_HOVER = "#1789a3"
COLOR_ACCENT = "#66c596"
COLOR_BG = "#f5f9fb"
COLOR_CARD = "#ffffff"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BORDER = "#dbe5eb"
COLOR_CLOSE_HOVER = "#d63b3b"
COLOR_WARN = "#d96a3c"
COLOR_OK = "#5cb85c"


def _color_for_balance(balance: int, cap: int) -> str:
    if balance <= 0:
        return "#dc3545"
    ratio = balance / max(1, cap)
    if ratio < 0.20:
        return COLOR_WARN
    if ratio < 0.50:
        return "#e6c533"
    return COLOR_OK


def _mode_label_cn(mode: str) -> str:
    return {
        "child": "使用中",
        "lock": "已锁定",
        "parent": "家长模式",
        "limited_free": "限免中",
    }.get(mode, mode)


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
QLabel#balance_big {{
    color: {accent};
    font-family: "Microsoft YaHei UI";
    font-size: 36pt;
    font-weight: bold;
}}
QLabel#balance_unit {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QLabel#mode_badge {{
    color: white;
    background-color: {mode_color};
    border-radius: 12px;
    padding: 4px 12px;
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
    font-weight: bold;
}}
QLabel#stat_value {{
    color: {text};
    font-family: "Microsoft YaHei UI";
    font-size: 16pt;
    font-weight: bold;
}}
QLabel#stat_label {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
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


class StatusPanel(QWidget):
    """模态-less 状态面板。

    数据通过 callable 注入, 每次 show() 时刷新一遍。
    再次点托盘 / 关闭按钮 → hide (不 destroy, 复用)。
    """

    def __init__(
        self,
        logo_path: str | Path | None,
        get_balance: Callable[[], int],
        get_mode: Callable[[], str],
        get_daily_consumed: Callable[[], int],
        get_daily_credited: Callable[[], int],
        get_today_consumption_minutes: Callable[[], int],
        get_checklist_progress: Callable[[], tuple[int, int]],
        on_lock: Callable[[], None],
        on_resume: Callable[[], None],
        get_active_unlocks: Callable[[], list[tuple[str, str, int]]] | None = None,
        daily_credit_cap: int = 120,
    ) -> None:
        super().__init__()
        self._logo_path = str(logo_path) if logo_path else None
        self._get_balance = get_balance
        self._get_mode = get_mode
        self._get_daily_consumed = get_daily_consumed
        self._get_daily_credited = get_daily_credited
        self._get_today_minutes = get_today_consumption_minutes
        self._get_checklist = get_checklist_progress
        self._on_lock = on_lock
        self._on_resume = on_resume
        self._get_active_unlocks = get_active_unlocks
        self._cap = daily_credit_cap

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(380, 460)

        if self._logo_path and Path(self._logo_path).exists():
            self.setWindowIcon(QIcon(self._logo_path))

        self._drag_pos: QPoint | None = None
        self._build_ui()
        self._center_on_screen()

    def _build_ui(self) -> None:
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

        card_layout = QVBoxLayout(self._card)
        card_layout.setContentsMargins(0, 0, 0, 0)
        card_layout.setSpacing(0)

        # Header
        header = QFrame(self._card)
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

        title = QLabel("NinoGame · 状态", header)
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
        card_layout.addWidget(header)

        # Body
        body = QWidget(self._card)
        body_layout = QVBoxLayout(body)
        body_layout.setContentsMargins(28, 22, 28, 22)
        body_layout.setSpacing(18)

        # 大余额数字行
        balance_row = QHBoxLayout()
        balance_row.setSpacing(10)
        self._balance_icon = QLabel(body)
        balance_row.addWidget(self._balance_icon)
        self._balance_big = QLabel("--", body)
        self._balance_big.setObjectName("balance_big")
        balance_row.addWidget(self._balance_big)
        unit_box = QVBoxLayout()
        unit_box.setSpacing(0)
        unit_box.addStretch(1)
        unit_label = QLabel("token", body)
        unit_label.setObjectName("balance_unit")
        unit_box.addWidget(unit_label)
        balance_row.addLayout(unit_box)
        balance_row.addStretch(1)
        self._mode_badge = QLabel("...", body)
        self._mode_badge.setObjectName("mode_badge")
        balance_row.addWidget(self._mode_badge)
        body_layout.addLayout(balance_row)

        # 分隔线
        line = QFrame(body)
        line.setFrameShape(QFrame.HLine)
        line.setStyleSheet(f"color: {COLOR_BORDER}; background-color: {COLOR_BORDER};")
        line.setFixedHeight(1)
        body_layout.addWidget(line)

        # 今日 stats 三列
        stats = QGridLayout()
        stats.setHorizontalSpacing(20)

        def _cell(icon_name: str, color: str, label: str):
            cell = QVBoxLayout()
            cell.setSpacing(4)
            cell.setAlignment(Qt.AlignCenter)
            top = QHBoxLayout()
            top.setAlignment(Qt.AlignCenter)
            top.setSpacing(6)
            ic = QLabel(body)
            ic.setPixmap(qta.icon(icon_name, color=color).pixmap(QSize(18, 18)))
            top.addWidget(ic)
            val = QLabel("0", body)
            val.setObjectName("stat_value")
            top.addWidget(val)
            cell.addLayout(top)
            lbl = QLabel(label, body)
            lbl.setObjectName("stat_label")
            lbl.setAlignment(Qt.AlignCenter)
            cell.addWidget(lbl)
            return cell, val

        col1, self._stat_consumed = _cell("fa5s.minus-circle", COLOR_WARN, "今日花费")
        col2, self._stat_earned = _cell("fa5s.plus-circle", COLOR_OK, "今日挣到")
        col3, self._stat_minutes = _cell("fa5s.clock", COLOR_PRIMARY, "今日游戏 (分钟)")
        col4, self._stat_tasks = _cell("fa5s.tasks", COLOR_PRIMARY, "责任清单")

        stats.addLayout(col1, 0, 0)
        stats.addLayout(col2, 0, 1)
        stats.addLayout(col3, 1, 0)
        stats.addLayout(col4, 1, 1)
        body_layout.addLayout(stats)

        # 活跃解锁区 (放行中的应用)
        self._unlocks_container = QVBoxLayout()
        self._unlocks_container.setSpacing(4)
        body_layout.addLayout(self._unlocks_container)

        body_layout.addStretch(1)

        # 操作按钮
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)

        self._btn_lock = QPushButton(body)
        self._btn_lock.setObjectName("ghost")
        self._btn_lock.setCursor(Qt.PointingHandCursor)
        self._btn_lock.setIcon(qta.icon("fa5s.lock", color=COLOR_TEXT_DIM))
        self._btn_lock.setIconSize(QSize(14, 14))
        self._btn_lock.setText("  锁定")
        self._btn_lock.clicked.connect(self._do_lock)
        btn_row.addWidget(self._btn_lock)

        self._btn_resume = QPushButton(body)
        self._btn_resume.setObjectName("primary")
        self._btn_resume.setCursor(Qt.PointingHandCursor)
        self._btn_resume.setIcon(qta.icon("fa5s.unlock", color="white"))
        self._btn_resume.setIconSize(QSize(14, 14))
        self._btn_resume.setText("  解锁使用")
        self._btn_resume.clicked.connect(self._do_resume)
        btn_row.addWidget(self._btn_resume)

        body_layout.addLayout(btn_row)
        card_layout.addWidget(body, 1)

        self._apply_qss(COLOR_OK, COLOR_PRIMARY)

    def _apply_qss(self, accent_for_balance: str, mode_color: str) -> None:
        qss = _QSS.format(
            card=COLOR_CARD,
            primary=COLOR_PRIMARY,
            primary_hover=COLOR_PRIMARY_HOVER,
            accent=accent_for_balance,
            text=COLOR_TEXT,
            text_dim=COLOR_TEXT_DIM,
            border=COLOR_BORDER,
            close_hover=COLOR_CLOSE_HOVER,
            mode_color=mode_color,
        )
        self.setStyleSheet(qss)

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

    @Slot()
    def show_panel(self) -> None:
        """主线程调用; 也可被 QMetaObject.invokeMethod 跨线程触发。"""
        self.refresh()
        self.show()
        self.raise_()
        self.activateWindow()

    def refresh(self) -> None:
        try:
            balance = int(self._get_balance())
            mode = self._get_mode()
            consumed = int(self._get_daily_consumed())
            credited = int(self._get_daily_credited())
            minutes = int(self._get_today_minutes())
            done, total = self._get_checklist()
        except Exception:
            _log.exception("StatusPanel refresh failed")
            return

        self._balance_big.setText(str(balance))
        accent = _color_for_balance(balance, self._cap)
        self._balance_icon.setPixmap(qta.icon("fa5s.gem", color=accent).pixmap(QSize(28, 28)))

        mode_color = {
            "child": COLOR_OK,
            "lock": "#888",
            "parent": COLOR_PRIMARY,
            "limited_free": COLOR_WARN,
        }.get(mode, COLOR_PRIMARY)
        self._mode_badge.setText(_mode_label_cn(mode))
        self._apply_qss(accent, mode_color)

        self._stat_consumed.setText(str(consumed))
        self._stat_earned.setText(str(credited))
        self._stat_minutes.setText(str(minutes))
        self._stat_tasks.setText(f"{done}/{total}")

        # 清空 + 重建活跃解锁列表
        self._clear_layout(self._unlocks_container)
        unlocks = []
        if self._get_active_unlocks is not None:
            try:
                unlocks = self._get_active_unlocks()
            except Exception:
                _log.exception("get_active_unlocks 失败")
        for _rid, name, secs in unlocks:
            self._unlocks_container.addLayout(self._build_unlock_row(name, secs))

    def _clear_layout(self, layout) -> None:
        while layout.count():
            item = layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
            child_layout = item.layout()
            if child_layout is not None:
                self._clear_layout(child_layout)

    def _build_unlock_row(self, rule_name: str, seconds: int):
        from PySide6.QtCore import Qt
        from PySide6.QtWidgets import QHBoxLayout, QLabel
        row = QHBoxLayout()
        row.setContentsMargins(0, 4, 0, 0)
        ic = QLabel(self)
        ic.setPixmap(qta.icon("fa5s.gift", color=COLOR_OK).pixmap(QSize(16, 16)))
        row.addWidget(ic)
        mins = max(1, seconds // 60)
        text = QLabel(f"放行中: {rule_name} · {mins} 分钟剩余", self)
        text.setStyleSheet(f"color: {COLOR_OK}; font-size: 9pt; font-weight: bold;")
        row.addWidget(text)
        row.addStretch(1)
        return row

    def _do_lock(self) -> None:
        try:
            self._on_lock()
        except Exception:
            _log.exception("on_lock 失败")
        QTimer.singleShot(200, self.refresh)

    def _do_resume(self) -> None:
        try:
            self._on_resume()
        except Exception:
            _log.exception("on_resume 失败")
        QTimer.singleShot(200, self.refresh)
