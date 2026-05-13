"""孩子端「申报任务完成」对话框 (CLAUDE.md §8.3 Path 3)。

数据流:
  Agent 启动后从 server 同步 tasks.json (incentive 类)
  孩子点托盘 "申报任务完成..." → 此对话框
  选一个任务 + 可选备注 → on_submit(task_id, child_note)
  main.py 包成 {type:"task_claim", payload:{task_id, child_note}} 发给 server
  server 写 task_completions(status=pending) + 推家长浏览器
  家长在 /tasks 批准 → wallet_update 推回 Agent
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
COLOR_ACCENT = "#66c596"
COLOR_CLOSE_HOVER = "#d63b3b"


class TaskClaimDialog(QWidget):
    """激励任务申报对话框。

    `get_tasks()` 返回 list[dict]: 每项至少含 id / name / reward_tokens / verification
    `on_submit(task_id, child_note) -> bool` 实际发送, 由 main.py 实现
    """

    def __init__(
        self,
        get_tasks: Callable[[], list[dict]],
        on_submit: Callable[[str, str], bool],
        logo_path: str | Path | None = None,
    ) -> None:
        super().__init__()
        self._get_tasks = get_tasks
        self._on_submit = on_submit
        self._logo_path = str(logo_path) if logo_path else None

        self.setWindowFlags(
            Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(460, 520)
        if self._logo_path and Path(self._logo_path).exists():
            self.setWindowIcon(QIcon(self._logo_path))
        self._drag_pos: QPoint | None = None

        self._build()
        self._center()

    # ── UI ─────────────────────────────────────────────────────
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
        title = QLabel("NinoGame · 申报任务完成", header)
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
        bl.setContentsMargins(20, 16, 20, 16)
        bl.setSpacing(10)

        intro = QLabel(
            "选一个你今天完成的任务, 点「申报完成」发给家长。\n"
            "家长批准后会自动加 token。",
            body,
        )
        intro.setObjectName("hint")
        intro.setWordWrap(True)
        bl.addWidget(intro)

        # 任务列表 (可滚)
        self._scroll = QScrollArea(body)
        self._scroll.setWidgetResizable(True)
        self._scroll.setObjectName("scroll")
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._list_host = QWidget()
        self._list_layout = QVBoxLayout(self._list_host)
        self._list_layout.setContentsMargins(0, 0, 0, 0)
        self._list_layout.setSpacing(8)
        self._scroll.setWidget(self._list_host)
        bl.addWidget(self._scroll, 1)

        # 备注
        note_label = QLabel("备注 (可选, 家长会看到)", body)
        note_label.setObjectName("hint")
        bl.addWidget(note_label)
        self._note = QLineEdit(body)
        self._note.setPlaceholderText("例: 写了三页, 但最后一题有点不确定")
        bl.addWidget(self._note)

        # 状态条
        self._status = QLabel("", body)
        self._status.setObjectName("hint")
        self._status.setWordWrap(True)
        bl.addWidget(self._status)

        # 关闭按钮
        bottom = QHBoxLayout()
        bottom.addStretch(1)
        refresh_btn = QPushButton(body)
        refresh_btn.setObjectName("ghost")
        refresh_btn.setCursor(Qt.PointingHandCursor)
        refresh_btn.setIcon(qta.icon("fa5s.sync", color=COLOR_TEXT_DIM))
        refresh_btn.setIconSize(QSize(13, 13))
        refresh_btn.setText("  刷新")
        refresh_btn.clicked.connect(self._reload_tasks)
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
        QLabel#hint {{ color: {COLOR_TEXT_DIM}; font-family: "Microsoft YaHei UI";
            font-size: 9pt; }}
        QScrollArea#scroll {{ border: 1px solid {COLOR_BORDER}; border-radius: 6px;
            background-color: {COLOR_BG}; }}
        QLineEdit {{ border: 1px solid {COLOR_BORDER}; border-radius: 6px;
            padding: 7px 10px; font-family: "Microsoft YaHei UI"; font-size: 10pt;
            color: {COLOR_TEXT}; background-color: white; }}
        QLineEdit:focus {{ border-color: {COLOR_PRIMARY}; }}
        QPushButton#primary {{ background-color: {COLOR_PRIMARY}; color: white;
            border: 0; border-radius: 6px; padding: 6px 14px;
            font-family: "Microsoft YaHei UI"; font-size: 9pt; font-weight: bold; }}
        QPushButton#primary:hover {{ background-color: {COLOR_PRIMARY_HOVER}; }}
        QPushButton#primary:disabled {{ background-color: {COLOR_BORDER}; color: {COLOR_TEXT_DIM}; }}
        QPushButton#ghost {{ background-color: transparent; color: {COLOR_TEXT_DIM};
            border: 1px solid {COLOR_BORDER}; border-radius: 6px; padding: 7px 14px;
            font-family: "Microsoft YaHei UI"; font-size: 9pt; }}
        QPushButton#ghost:hover {{ color: {COLOR_TEXT}; border-color: {COLOR_PRIMARY}; }}
        QPushButton#close {{ background-color: transparent; color: white;
            border: 0; font-size: 18pt; font-family: "Segoe UI Symbol"; }}
        QPushButton#close:hover {{ background-color: {COLOR_CLOSE_HOVER};
            border-top-right-radius: 14px; }}
        """)

    # ── 行: 单个任务 ────────────────────────────────────────────
    def _build_task_row(self, task: dict) -> QWidget:
        row = QFrame(self._list_host)
        row.setStyleSheet(
            f"QFrame {{ background-color: {COLOR_CARD}; border: 1px solid {COLOR_BORDER};"
            f" border-radius: 6px; }}"
        )
        rl = QHBoxLayout(row)
        rl.setContentsMargins(12, 10, 10, 10)
        rl.setSpacing(10)

        icon_lbl = QLabel(row)
        icon_lbl.setPixmap(
            qta.icon("fa5s.clipboard-check", color=COLOR_PRIMARY).pixmap(QSize(18, 18))
        )
        rl.addWidget(icon_lbl)

        text_box = QVBoxLayout()
        text_box.setSpacing(2)
        name = QLabel(str(task.get("name", "")), row)
        name.setStyleSheet(
            f"color: {COLOR_TEXT}; font-family: 'Microsoft YaHei UI'; "
            f"font-size: 10pt; font-weight: bold; border: 0;"
        )
        text_box.addWidget(name)
        verification_map = {
            "parent_approve": "家长审批",
            "photo": "拍照证明",
            "self_report": "自报为准",
            "auto": "自动检测",
        }
        sub = QLabel(
            verification_map.get(task.get("verification", ""), "家长审批"),
            row,
        )
        sub.setStyleSheet(
            f"color: {COLOR_TEXT_DIM}; font-family: 'Microsoft YaHei UI'; "
            f"font-size: 8pt; border: 0;"
        )
        text_box.addWidget(sub)
        rl.addLayout(text_box)
        rl.addStretch(1)

        reward = int(task.get("reward_tokens", 0) or 0)
        reward_lbl = QLabel(f"+{reward}", row)
        reward_lbl.setStyleSheet(
            f"color: {COLOR_ACCENT}; font-family: 'Microsoft YaHei UI'; "
            f"font-size: 12pt; font-weight: bold; border: 0;"
        )
        rl.addWidget(reward_lbl)

        btn = QPushButton(row)
        btn.setObjectName("primary")
        btn.setCursor(Qt.PointingHandCursor)
        btn.setText("申报完成")
        task_id = str(task.get("id", ""))
        btn.clicked.connect(lambda _checked=False, tid=task_id, b=btn: self._submit(tid, b))
        rl.addWidget(btn)

        return row

    # ── 数据 ───────────────────────────────────────────────────
    def _reload_tasks(self) -> None:
        # 清空旧 children
        while self._list_layout.count():
            it = self._list_layout.takeAt(0)
            w = it.widget()
            if w is not None:
                w.deleteLater()
        # 拉新
        try:
            tasks = list(self._get_tasks() or [])
        except Exception:
            _log.exception("get_tasks failed")
            tasks = []
        if not tasks:
            empty = QLabel(
                "还没有激励任务。\n等家长在浏览器 /tasks 页配置后, 这里会显示出来。",
                self._list_host,
            )
            empty.setAlignment(Qt.AlignCenter)
            empty.setStyleSheet(
                f"color: {COLOR_TEXT_DIM}; font-family: 'Microsoft YaHei UI'; "
                f"font-size: 9pt; padding: 30px;"
            )
            empty.setWordWrap(True)
            self._list_layout.addWidget(empty)
            return
        for t in tasks:
            self._list_layout.addWidget(self._build_task_row(t))
        self._list_layout.addStretch(1)

    def _submit(self, task_id: str, btn: QPushButton) -> None:
        if not task_id:
            return
        note = self._note.text().strip()
        btn.setEnabled(False)
        btn.setText("发送中...")
        self._status.setText("发送中...")
        QApplication.processEvents()
        ok = False
        try:
            ok = bool(self._on_submit(task_id, note))
        except Exception:
            _log.exception("on_submit failed")
            ok = False
        if ok:
            btn.setText("✓ 已申报")
            self._status.setText(
                "✓ 已发送给家长。批准后浏览器会发奖励, 余额会自动更新, "
                "你可以继续做别的事。"
            )
            self._note.clear()
        else:
            btn.setEnabled(True)
            btn.setText("申报完成")
            self._status.setText(
                "× 发送失败 — 检查 Agent 是否已配对 + WebSocket 是否连上。"
            )

    # ── 入口 ───────────────────────────────────────────────────
    def show_for_user(self) -> None:
        self._reload_tasks()
        self._note.clear()
        self._status.clear()
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
