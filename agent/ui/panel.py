"""StatusPanel: 托盘双击弹出的状态总览面板 (CLAUDE.md §15.4 + §15.5)。

展示:
  - 当前 Token 数 (大号数字, 颜色按比例)
  - 当前模式徽章 (使用中 / 未在使用 / 限免中 / 家长模式)
  - 限免横幅 (free_pass > 0 时醒目展示倒计时)
  - Forecast: "按当前速度还能用 X 分钟" (§15.5)
  - 今日花费 / 挣到 / 游戏分钟 / 责任清单
  - 活跃放行 (临时 unlock 剩余分钟)
  - 操作区: 申请游戏时间 / 申报任务完成 / 我的消息 / Token 变动 /
            重新配对 / 切回孩子 (家长模式)
  - Header: ℹ 关于

UX:
  - 面板可见时每 1s 自动刷新 (QTimer), 数字"活起来", 限免/forecast 倒数
  - 关闭/隐藏时 timer 停, 不浪费 CPU
  - 拖动 header 移动窗口; × 关闭 (不 destroy, 下次复用)
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
COLOR_GIFT = "#e6a23c"   # 限免横幅


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
        "lock": "未在使用",
        "parent": "家长模式",
        "limited_free": "限免中",
    }.get(mode, mode)


def _fmt_mmss(seconds: int) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


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
QFrame#free_pass_banner {{
    background-color: {gift_bg};
    border: 1px solid {gift_border};
    border-radius: 8px;
}}
QLabel#free_pass_text {{
    color: {gift};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
    font-weight: bold;
}}
QLabel#forecast {{
    color: {text_dim};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
}}
QLabel#forecast_value {{
    color: {text};
    font-family: "Microsoft YaHei UI";
    font-size: 10pt;
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
    border-radius: 8px;
    padding: 10px 20px;
    font-family: "Microsoft YaHei UI";
    font-size: 11pt;
    font-weight: bold;
}}
QPushButton#primary:hover {{
    background-color: {primary_hover};
}}
QPushButton#primary:disabled {{
    background-color: {border};
    color: {text_dim};
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
QPushButton#header_icon {{
    background-color: transparent;
    border: 0;
}}
QPushButton#header_icon:hover {{
    background-color: rgba(255, 255, 255, 40);
}}
QPushButton#ghost {{
    background-color: transparent;
    color: {text};
    border: 1px solid {border};
    border-radius: 6px;
    padding: 8px 10px;
    font-family: "Microsoft YaHei UI";
    font-size: 9pt;
    text-align: left;
}}
QPushButton#ghost:hover {{
    border-color: {primary};
    color: {primary};
}}
QPushButton#ghost:disabled {{
    color: {text_dim};
    border-color: {border};
}}
"""


class StatusPanel(QWidget):
    """状态面板。

    数据通过 callable 注入, 面板可见时每 1s 调一遍 refresh()。
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
        get_active_unlocks: Callable[[], list[tuple[str, str, int]]] | None = None,
        get_free_pass_seconds: Callable[[], int] | None = None,
        get_consumption_rate_per_minute: Callable[[], float] | None = None,
        on_request_unlock: Callable[[], None] | None = None,
        on_task_claim: Callable[[], None] | None = None,
        on_show_messages: Callable[[], None] | None = None,
        on_show_ledger: Callable[[], None] | None = None,
        on_switch_to_child: Callable[[], None] | None = None,
        on_show_pair: Callable[[], None] | None = None,
        on_show_about: Callable[[], None] | None = None,
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
        self._get_active_unlocks = get_active_unlocks
        self._get_free_pass_seconds = get_free_pass_seconds
        self._get_rate = get_consumption_rate_per_minute
        self._on_request_unlock = on_request_unlock
        self._on_task_claim = on_task_claim
        self._on_show_messages = on_show_messages
        self._on_show_ledger = on_show_ledger
        self._on_switch_to_child = on_switch_to_child
        self._on_show_pair = on_show_pair
        self._on_show_about = on_show_about
        self._cap = daily_credit_cap

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        # 加按钮区后 panel 高度需要更大
        self.resize(420, 640)

        if self._logo_path and Path(self._logo_path).exists():
            self.setWindowIcon(QIcon(self._logo_path))

        # 可见时每秒 refresh; hide 时停。避免后台空跑。
        self._refresh_timer = QTimer(self)
        self._refresh_timer.setInterval(1000)
        self._refresh_timer.timeout.connect(self.refresh)

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

        # ── Header ─────────────────────────────────────────
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

        # ℹ 关于 (header 上)
        if self._on_show_about is not None:
            about_btn = QPushButton(header)
            about_btn.setObjectName("header_icon")
            about_btn.setIcon(qta.icon("fa5s.info-circle", color="white"))
            about_btn.setIconSize(QSize(16, 16))
            about_btn.setFixedSize(36, 44)
            about_btn.setCursor(Qt.PointingHandCursor)
            about_btn.setToolTip("关于 NinoGame")
            about_btn.clicked.connect(lambda: self._safe_call(self._on_show_about))
            h.addWidget(about_btn)

        close_btn = QPushButton("×", header)
        close_btn.setObjectName("close")
        close_btn.setFixedSize(46, 44)
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.clicked.connect(self.hide)
        h.addWidget(close_btn)

        header.mousePressEvent = self._header_press
        header.mouseMoveEvent = self._header_move
        header.setCursor(Qt.SizeAllCursor)
        card_layout.addWidget(header)

        # ── Body ───────────────────────────────────────────
        body = QWidget(self._card)
        body_layout = QVBoxLayout(body)
        body_layout.setContentsMargins(24, 20, 24, 20)
        body_layout.setSpacing(14)

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

        # 限免横幅 (默认隐藏)
        self._free_pass_banner = QFrame(body)
        self._free_pass_banner.setObjectName("free_pass_banner")
        fp_l = QHBoxLayout(self._free_pass_banner)
        fp_l.setContentsMargins(12, 8, 12, 8)
        fp_l.setSpacing(8)
        self._fp_icon = QLabel(self._free_pass_banner)
        self._fp_icon.setPixmap(qta.icon("fa5s.gift", color=COLOR_GIFT).pixmap(QSize(18, 18)))
        fp_l.addWidget(self._fp_icon)
        self._fp_text = QLabel("", self._free_pass_banner)
        self._fp_text.setObjectName("free_pass_text")
        fp_l.addWidget(self._fp_text)
        fp_l.addStretch(1)
        self._free_pass_banner.setVisible(False)
        body_layout.addWidget(self._free_pass_banner)

        # Forecast 行
        fc_row = QHBoxLayout()
        fc_row.setSpacing(6)
        self._fc_icon = QLabel(body)
        self._fc_icon.setPixmap(qta.icon("fa5s.hourglass-half", color=COLOR_TEXT_DIM).pixmap(QSize(14, 14)))
        fc_row.addWidget(self._fc_icon)
        self._fc_label = QLabel("按当前速度", body)
        self._fc_label.setObjectName("forecast")
        fc_row.addWidget(self._fc_label)
        self._fc_value = QLabel("--", body)
        self._fc_value.setObjectName("forecast_value")
        fc_row.addWidget(self._fc_value)
        fc_row.addStretch(1)
        body_layout.addLayout(fc_row)

        # 分隔线
        line = QFrame(body)
        line.setFrameShape(QFrame.HLine)
        line.setStyleSheet(f"color: {COLOR_BORDER}; background-color: {COLOR_BORDER};")
        line.setFixedHeight(1)
        body_layout.addWidget(line)

        # 今日 stats 2x2
        stats = QGridLayout()
        stats.setHorizontalSpacing(20)
        stats.setVerticalSpacing(10)

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

        col1, self._stat_consumed = _cell("fa5s.minus-circle", COLOR_WARN, "今日花费 token")
        col2, self._stat_earned = _cell("fa5s.plus-circle", COLOR_OK, "今日挣到 token")
        col3, self._stat_minutes = _cell("fa5s.clock", COLOR_PRIMARY, "今日游戏 (分钟)")
        col4, self._stat_tasks = _cell("fa5s.tasks", COLOR_PRIMARY, "责任清单")

        stats.addLayout(col1, 0, 0)
        stats.addLayout(col2, 0, 1)
        stats.addLayout(col3, 1, 0)
        stats.addLayout(col4, 1, 1)
        body_layout.addLayout(stats)

        # 活跃放行区
        self._unlocks_container = QVBoxLayout()
        self._unlocks_container.setSpacing(4)
        body_layout.addLayout(self._unlocks_container)

        body_layout.addStretch(1)

        # ── 主按钮: 申请游戏时间 ─────────────────────────────
        if self._on_request_unlock is not None:
            self._request_btn = QPushButton("申请游戏时间…", body)
            self._request_btn.setObjectName("primary")
            self._request_btn.setCursor(Qt.PointingHandCursor)
            self._request_btn.clicked.connect(self._handle_request_click)
            body_layout.addWidget(self._request_btn)
        else:
            self._request_btn = None

        # ── 二级动作 (从托盘菜单搬来) ────────────────────────
        # 2×n grid: 申报任务 / 我的消息 / Token 变动 / 切回孩子 / 重新配对
        # 没注入对应 callback 的项整个不出现
        actions = QGridLayout()
        actions.setHorizontalSpacing(8)
        actions.setVerticalSpacing(8)
        self._action_buttons: list[tuple[QPushButton, str]] = []  # (btn, key) 供 refresh 控制可见性

        def _add(icon: str, label: str, key: str, slot, row: int, col: int) -> QPushButton:
            btn = QPushButton(label, body)
            btn.setObjectName("ghost")
            btn.setIcon(qta.icon(icon, color=COLOR_PRIMARY))
            btn.setIconSize(QSize(14, 14))
            btn.setCursor(Qt.PointingHandCursor)
            btn.clicked.connect(slot)
            actions.addWidget(btn, row, col)
            self._action_buttons.append((btn, key))
            return btn

        row, col = 0, 0

        def _next() -> tuple[int, int]:
            nonlocal row, col
            r, c = row, col
            col += 1
            if col >= 2:
                col = 0
                row += 1
            return r, c

        if self._on_task_claim is not None:
            r, c = _next()
            _add("fa5s.check-circle", "申报任务完成", "task_claim",
                 lambda: self._safe_call(self._on_task_claim), r, c)
        if self._on_show_messages is not None:
            r, c = _next()
            _add("fa5s.envelope-open-text", "我的消息", "messages",
                 lambda: self._safe_call(self._on_show_messages), r, c)
        if self._on_show_ledger is not None:
            r, c = _next()
            _add("fa5s.coins", "Token 变动", "ledger",
                 lambda: self._safe_call(self._on_show_ledger), r, c)
        if self._on_switch_to_child is not None:
            r, c = _next()
            _add("fa5s.user", "切回孩子模式", "switch_child",
                 lambda: self._safe_call(self._on_switch_to_child), r, c)
        if self._on_show_pair is not None:
            r, c = _next()
            _add("fa5s.link", "重新配对家长后台", "pair",
                 lambda: self._safe_call(self._on_show_pair), r, c)
        # 没按钮就不加 grid; 有按钮时确保最后一行有元素 (奇数个按钮时占位空)
        if self._action_buttons:
            # 占位让奇数按钮也能 50% 宽 (不被拉伸)
            if col == 1:
                spacer = QLabel("", body)
                actions.addWidget(spacer, row, col)
            body_layout.addLayout(actions)

        card_layout.addWidget(body, 1)

        self._apply_qss(COLOR_OK, COLOR_PRIMARY)

    def _safe_call(self, fn) -> None:
        if fn is None:
            return
        try:
            fn()
        except Exception:
            _log.exception("panel action callback 失败")

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
            gift=COLOR_GIFT,
            gift_bg="#fdf5e6",
            gift_border="#f4d8a1",
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

    def _handle_request_click(self) -> None:
        if self._on_request_unlock is None:
            return
        # 申请对话框打开后, 状态面板可以一直留着 (孩子可能想边看额度边申请),
        # 不主动 hide。
        try:
            self._on_request_unlock()
        except Exception:
            _log.exception("on_request_unlock 触发失败")

    # ── 显示/隐藏: 控制 timer ─────────────────────────────
    def showEvent(self, event) -> None:
        super().showEvent(event)
        if not self._refresh_timer.isActive():
            self._refresh_timer.start()

    def hideEvent(self, event) -> None:
        self._refresh_timer.stop()
        super().hideEvent(event)

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
            free_pass_secs = int(self._get_free_pass_seconds()) if self._get_free_pass_seconds else 0
            rate = float(self._get_rate()) if self._get_rate else 1.0
        except Exception:
            _log.exception("StatusPanel refresh failed")
            return

        self._balance_big.setText(str(balance))
        accent = _color_for_balance(balance, self._cap)
        self._balance_icon.setPixmap(qta.icon("fa5s.gem", color=accent).pixmap(QSize(28, 28)))

        mode_color = {
            "child": COLOR_OK,
            "lock": "#9aa9b1",
            "parent": COLOR_PRIMARY,
            "limited_free": COLOR_GIFT,
        }.get(mode, COLOR_PRIMARY)
        self._mode_badge.setText(_mode_label_cn(mode))
        # lock 也展示徽章 ("未在使用" 比完全隐藏更让孩子看明白当前状态)
        self._mode_badge.setVisible(True)
        self._apply_qss(accent, mode_color)

        # 限免横幅
        if free_pass_secs > 0:
            self._fp_text.setText(f"🎁 限免中 · 剩 {_fmt_mmss(free_pass_secs)}, 这段时间不扣 token")
            self._free_pass_banner.setVisible(True)
        else:
            self._free_pass_banner.setVisible(False)

        # Forecast (§15.5)
        self._update_forecast(balance, mode, rate, free_pass_secs)

        self._stat_consumed.setText(str(consumed))
        self._stat_earned.setText(str(credited))
        self._stat_minutes.setText(str(minutes))
        self._stat_tasks.setText(f"{done}/{total}")

        # 申请按钮: 限免 / 已锁定 / token 0 时给不同提示
        if self._request_btn is not None:
            if free_pass_secs > 0:
                self._request_btn.setEnabled(False)
                self._request_btn.setText("限免中, 无需申请")
            elif mode == "parent":
                self._request_btn.setEnabled(False)
                self._request_btn.setText("家长模式中")
            else:
                self._request_btn.setEnabled(True)
                self._request_btn.setText("申请游戏时间…")

        # 二级按钮模式感知:
        # - task_claim 仅 child 模式有意义
        # - switch_child 仅 parent 模式有意义
        # - messages / ledger / pair 任何模式都可用
        for btn, key in self._action_buttons:
            if key == "task_claim":
                btn.setVisible(mode == "child")
            elif key == "switch_child":
                btn.setVisible(mode == "parent")
            else:
                btn.setVisible(True)

        # 清空 + 重建活跃放行列表
        self._clear_layout(self._unlocks_container)
        unlocks = []
        if self._get_active_unlocks is not None:
            try:
                unlocks = self._get_active_unlocks()
            except Exception:
                _log.exception("get_active_unlocks 失败")
        for _rid, name, secs in unlocks:
            self._unlocks_container.addLayout(self._build_unlock_row(name, secs))

    def _update_forecast(self, balance: int, mode: str, rate: float, free_pass_secs: int) -> None:
        """§15.5 Forecast: 按当前速度还能用 X 分钟。

        - 限免中 → "限免期间不扣 token"
        - lock / parent → "暂未在使用"
        - child + token > 0 + rate > 0 → "还能用 X 分钟" / "还能用 Y 小时"
        - token ≤ 0 → "Token 已用完, 去申请或挣分"
        """
        if free_pass_secs > 0:
            self._fc_label.setText("限免期间不扣 Token, 等 ")
            self._fc_value.setText(_fmt_mmss(free_pass_secs) + " 后恢复")
            return
        if mode != "child":
            self._fc_label.setText("当前")
            self._fc_value.setText("暂未在使用")
            return
        if balance <= 0:
            self._fc_label.setText("Token")
            self._fc_value.setText("已用完, 去申请或挣分")
            return
        if rate <= 0:
            self._fc_label.setText("当前")
            self._fc_value.setText("不扣 token")
            return
        minutes_left = int(balance / rate)
        if minutes_left >= 60:
            hours = minutes_left // 60
            rem = minutes_left % 60
            txt = f"{hours} 小时 {rem} 分钟" if rem > 0 else f"{hours} 小时"
        else:
            txt = f"{minutes_left} 分钟"
        self._fc_label.setText("按当前速度还能用")
        self._fc_value.setText(txt)

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
        ic.setPixmap(qta.icon("fa5s.unlock", color=COLOR_OK).pixmap(QSize(16, 16)))
        row.addWidget(ic)
        mins = max(1, seconds // 60)
        text = QLabel(f"放行中: {rule_name} · 剩 {mins} 分钟", self)
        text.setStyleSheet(f"color: {COLOR_OK}; font-size: 9pt; font-weight: bold;")
        row.addWidget(text)
        row.addStretch(1)
        return row
