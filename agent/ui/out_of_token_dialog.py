"""Token 余额耗尽全屏锁屏 (像网吧那样)。

触发: token_engine 检测到 cur_balance < cost → main.py 切 Lock 模式
      + 弹本对话框 (全屏覆盖, 不能 Alt-Tab 跳过).

三选一:
  申请游戏时间    → 走 RequestDialog (孩子写理由 → 家长批准 → temporary_unlock)
  家长 PIN 解锁  → 弹 PinDialog 验证家长 PIN, 通过后切到 Parent Mode (不计费)
  关机休息       → 倒计时 30s 调 shutdown (期间可取消)

设计:
  - 全屏 black/75% semi-transparent 蒙层覆盖整个桌面
  - 中央居中卡片 (不可拖动, 视觉权威感)
  - 没有 × 关闭按钮 (必须三选一才能跳过 Lock)
  - 余额回正时 main.py 主动 hide + 切回 Child
"""
from __future__ import annotations

import ctypes
import logging
import subprocess
import sys
from pathlib import Path
from typing import Callable

import qtawesome as qta
from PySide6.QtCore import Qt, QSize, QTimer
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

COLOR_PRIMARY = "#1ea7c4"
COLOR_PRIMARY_HOVER = "#1789a3"
COLOR_WARN = "#d63b3b"
COLOR_WARN_HOVER = "#b32d2d"
COLOR_PARENT = "#7c4dff"   # 紫色 = 家长模式
COLOR_PARENT_HOVER = "#6035d4"
COLOR_BG_OVERLAY = "rgba(0, 0, 0, 200)"   # 75% 不透明黑色蒙层
COLOR_CARD = "#ffffff"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BORDER = "#dbe5eb"


class OutOfTokenDialog(QWidget):
    """全屏锁屏式对话框。

    on_request           : 点"申请" 按钮 → 调用方关本窗 + 弹 RequestDialog
    on_parent_unlock     : 点"PIN 解锁" 按钮 → 调用方走 PinDialog 验证 +
                           通过后切 Parent Mode + 关本窗 (失败保持本窗)
    """

    def __init__(
        self,
        on_request: Callable[[], None],
        on_parent_unlock: Callable[[], None],
        logo_path: str | Path | None = None,
    ) -> None:
        super().__init__()
        self._on_request = on_request
        self._on_parent_unlock = on_parent_unlock
        self._logo_path = str(logo_path) if logo_path else None

        # 全屏覆盖 + 始终置顶 + 无边框 + 跳过 taskbar
        self.setWindowFlags(
            Qt.Window
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool   # 不出现在 Alt-Tab / taskbar
        )

        # 关机倒计时
        self._shutdown_timer: QTimer | None = None
        self._shutdown_remaining = 0
        # 防 Alt-Tab 切走的"抢焦点"循环 timer (200ms 一次)
        self._reclaim_timer: QTimer | None = None

        self._build()

    def _build(self) -> None:
        # 顶层窗口本身做黑色蒙层 (不开 TranslucentBackground 是因为
        # showFullScreen 与 TranslucentBackground 在 Windows 上偶有兼容问题)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        # 蒙层 widget
        overlay = QWidget(self)
        overlay.setObjectName("overlay")
        outer.addWidget(overlay)
        ov = QVBoxLayout(overlay)
        ov.setContentsMargins(40, 60, 40, 60)
        ov.addStretch(1)

        # 居中卡片
        card = QFrame(overlay)
        card.setObjectName("card")
        card.setFixedWidth(560)
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(40)
        shadow.setOffset(0, 6)
        shadow.setColor(QColor(0, 0, 0, 120))
        card.setGraphicsEffect(shadow)

        # 卡片内部布局
        cl = QVBoxLayout(card)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(0)

        # Header (红色警示)
        header = QFrame(card)
        header.setObjectName("header")
        header.setFixedHeight(56)
        h = QHBoxLayout(header)
        h.setContentsMargins(20, 0, 20, 0)
        h.setSpacing(10)
        if self._logo_path and Path(self._logo_path).exists():
            ic = QLabel(header)
            ic.setPixmap(
                QPixmap(self._logo_path).scaled(
                    32, 32, Qt.KeepAspectRatio, Qt.SmoothTransformation,
                )
            )
            h.addWidget(ic)
        title = QLabel("NinoGame · Token 用光了", header)
        title.setObjectName("htitle")
        h.addWidget(title)
        h.addStretch(1)
        cl.addWidget(header)

        # Body
        body = QWidget(card)
        bl = QVBoxLayout(body)
        bl.setContentsMargins(40, 32, 40, 28)
        bl.setSpacing(16)

        # 大图标
        icon_lbl = QLabel(body)
        icon_lbl.setPixmap(qta.icon("fa5s.battery-empty", color=COLOR_WARN).pixmap(QSize(64, 64)))
        icon_lbl.setAlignment(Qt.AlignCenter)
        bl.addWidget(icon_lbl)

        big_msg = QLabel("你的 token 已经用完了", body)
        big_msg.setObjectName("big_title")
        big_msg.setAlignment(Qt.AlignCenter)
        bl.addWidget(big_msg)

        hint = QLabel(
            "电脑现在被锁住了, 不能继续玩。\n选下面一个:",
            body,
        )
        hint.setObjectName("hint")
        hint.setAlignment(Qt.AlignCenter)
        hint.setWordWrap(True)
        bl.addWidget(hint)

        # 状态条 (关机倒计时显示)
        self._status = QLabel("", body)
        self._status.setObjectName("status")
        self._status.setAlignment(Qt.AlignCenter)
        self._status.setVisible(False)
        bl.addWidget(self._status)

        bl.addSpacing(8)

        # 三个按钮 (竖向, 大尺寸)
        self._btn_request = self._make_button(
            body, "申请游戏时间", "fa5s.paper-plane", COLOR_PRIMARY,
            "和家长说一下想做什么, 家长批准后可继续玩",
        )
        self._btn_request.clicked.connect(self._do_request)
        bl.addWidget(self._btn_request)

        self._btn_parent_unlock = self._make_button(
            body, "家长 PIN 解锁", "fa5s.user-shield", COLOR_PARENT,
            "家长输 PIN 后切到家长模式 (不计费)",
        )
        self._btn_parent_unlock.clicked.connect(self._do_parent_unlock)
        bl.addWidget(self._btn_parent_unlock)

        self._btn_shutdown = self._make_button(
            body, "关机休息", "fa5s.power-off", COLOR_WARN,
            "10 分钟后关机, 期间可点取消",
        )
        self._btn_shutdown.clicked.connect(self._do_shutdown)
        bl.addWidget(self._btn_shutdown)

        cl.addWidget(body, 1)

        # 把 card 居中放进蒙层
        center_wrap = QHBoxLayout()
        center_wrap.addStretch(1)
        center_wrap.addWidget(card)
        center_wrap.addStretch(1)
        ov.addLayout(center_wrap)
        ov.addStretch(1)

        self.setStyleSheet(f"""
        QWidget#overlay {{ background-color: {COLOR_BG_OVERLAY}; }}
        QFrame#card {{ background-color: {COLOR_CARD}; border-radius: 14px; }}
        QFrame#header {{ background-color: {COLOR_WARN};
            border-top-left-radius: 14px; border-top-right-radius: 14px; }}
        QLabel#htitle {{ color: white; font-family: "Microsoft YaHei UI";
            font-size: 13pt; font-weight: bold; }}
        QLabel#big_title {{ color: {COLOR_TEXT}; font-family: "Microsoft YaHei UI";
            font-size: 18pt; font-weight: bold; }}
        QLabel#hint {{ color: {COLOR_TEXT_DIM}; font-family: "Microsoft YaHei UI";
            font-size: 10pt; }}
        QLabel#status {{ color: {COLOR_WARN}; font-family: "Microsoft YaHei UI";
            font-size: 10pt; padding: 6px;
            background-color: rgba(214, 59, 59, 25); border-radius: 6px; }}
        """)

    def _make_button(
        self, parent: QWidget, label: str, icon_name: str, color: str, subtitle: str,
    ) -> QPushButton:
        btn = QPushButton(parent)
        btn.setCursor(Qt.PointingHandCursor)
        btn.setMinimumHeight(56)
        btn.setIcon(qta.icon(icon_name, color="white"))
        btn.setIconSize(QSize(20, 20))
        btn.setText(f"  {label}\n  {subtitle}")
        hover = self._darker(color)
        btn.setStyleSheet(
            f"QPushButton {{ background-color: {color}; color: white; "
            f"border: 0; border-radius: 10px; padding: 8px 18px; text-align: left; "
            f'font-family: "Microsoft YaHei UI"; font-size: 11pt; font-weight: bold; }} '
            f"QPushButton:hover {{ background-color: {hover}; }} "
            f"QPushButton:disabled {{ background-color: #b8c4cc; }}"
        )
        return btn

    @staticmethod
    def _darker(hex_color: str) -> str:
        # 简单变深: 直接返回固定 hover 色 (按钮颜色对应一个查表)
        table = {
            COLOR_PRIMARY: COLOR_PRIMARY_HOVER,
            COLOR_WARN: COLOR_WARN_HOVER,
            COLOR_PARENT: COLOR_PARENT_HOVER,
        }
        return table.get(hex_color, hex_color)

    # ── 按钮回调 ──────────────────────────────────────────────
    def _do_request(self) -> None:
        _log.info("[OutOfTokenDialog] 申请按钮被点击")
        try:
            self._on_request()
        except Exception:
            _log.exception("on_request 回调失败")
        # 不 hide: 让 main.py 在 RequestDialog 弹出后决定是否同时 hide 本窗

    def _do_parent_unlock(self) -> None:
        _log.info("[OutOfTokenDialog] 家长 PIN 解锁按钮被点击")
        try:
            self._on_parent_unlock()
        except Exception:
            _log.exception("on_parent_unlock 回调失败")
        # main.py 验证 PIN 通过 → 切 Parent + hide 本窗; 失败保持

    def _do_shutdown(self) -> None:
        _log.info("[OutOfTokenDialog] 关机按钮被点击")
        if self._shutdown_timer is not None:
            self._cancel_shutdown()
            return
        ok = self._trigger_shutdown(seconds=600)  # 10 分钟
        if not ok:
            self._status.setText("× 系统拒绝关机, 联系家长")
            self._status.setVisible(True)
            return
        self._shutdown_remaining = 600
        self._shutdown_timer = QTimer(self)
        self._shutdown_timer.timeout.connect(self._tick_shutdown)
        self._shutdown_timer.start(1000)
        self._btn_shutdown.setText("  取消关机\n  恢复 token 操作")
        self._btn_request.setEnabled(False)
        self._btn_parent_unlock.setEnabled(False)
        self._update_shutdown_status()

    def _tick_shutdown(self) -> None:
        self._shutdown_remaining -= 1
        if self._shutdown_remaining <= 0:
            if self._shutdown_timer is not None:
                self._shutdown_timer.stop()
            self._status.setText("正在关机...")
            return
        self._update_shutdown_status()

    def _update_shutdown_status(self) -> None:
        # 大于 60s 显示分:秒; 否则只显示秒
        s = self._shutdown_remaining
        if s >= 60:
            text = f"⚠ {s // 60} 分 {s % 60} 秒后关机 (再次点关机按钮可取消)"
        else:
            text = f"⚠ {s} 秒后关机 (再次点关机按钮可取消)"
        self._status.setText(text)
        self._status.setVisible(True)

    def _cancel_shutdown(self) -> None:
        _log.info("[OutOfTokenDialog] 取消关机")
        if self._shutdown_timer is not None:
            self._shutdown_timer.stop()
            self._shutdown_timer = None
        try:
            if sys.platform == "win32":
                subprocess.run(["shutdown", "/a"], check=False, timeout=5)
            elif sys.platform.startswith("linux"):
                subprocess.run(["shutdown", "-c"], check=False, timeout=5)
        except Exception:
            _log.exception("取消关机命令失败")
        self._status.setVisible(False)
        self._btn_shutdown.setText("  关机休息\n  10 分钟后关机, 期间可点取消")
        self._btn_request.setEnabled(True)
        self._btn_parent_unlock.setEnabled(True)

    def _trigger_shutdown(self, seconds: int = 600) -> bool:
        try:
            if sys.platform == "win32":
                subprocess.Popen([
                    "shutdown", "/s", "/t", str(seconds),
                    "/c", f"NinoGame: token 用光, {seconds // 60} 分钟后关机休息",
                ])
                return True
            elif sys.platform.startswith("linux"):
                subprocess.Popen([
                    "shutdown", "-h", f"+{max(1, seconds // 60)}",
                    "NinoGame: token 用光",
                ])
                return True
            return False
        except FileNotFoundError:
            _log.exception("shutdown 命令未找到")
            return False
        except Exception:
            _log.exception("触发 shutdown 失败")
            return False

    # ── 入口 ──────────────────────────────────────────────────
    def show_for_user(self) -> None:
        # 进入全屏锁屏态
        self._status.setVisible(False)
        if self._shutdown_timer is not None:
            self._cancel_shutdown()
        # 重新启用按钮 (上次可能被关机倒计时禁了)
        self._btn_request.setEnabled(True)
        self._btn_parent_unlock.setEnabled(True)
        # 全屏 + 抢焦点
        self.showFullScreen()
        self._reclaim_focus()
        # 启动抢焦点 timer: Alt-Tab 切走后 200ms 内被抢回, 防孩子切到底下窗口
        if self._reclaim_timer is None:
            self._reclaim_timer = QTimer(self)
            self._reclaim_timer.timeout.connect(self._reclaim_focus)
        self._reclaim_timer.start(200)

    def hide_for_user(self) -> None:
        # 退出锁屏 (token 回正 / 家长解锁后调)
        if self._reclaim_timer is not None:
            self._reclaim_timer.stop()
        if self._shutdown_timer is not None:
            self._cancel_shutdown()
        self.hide()

    def _reclaim_focus(self) -> None:
        """每 200ms 把焦点抢回. 视觉效果: 孩子按 Alt-Tab 几乎没反应,
        锁屏一直在最前."""
        if not self.isVisible():
            return
        try:
            self.raise_()
            self.activateWindow()
            # Windows: 直接调 SetForegroundWindow 比 Qt 抢得稳; 失败也无所谓
            if sys.platform == "win32":
                try:
                    hwnd = int(self.winId())
                    ctypes.windll.user32.SetForegroundWindow(hwnd)
                    # 顺手 BringWindowToTop 让 z-order 也最前
                    ctypes.windll.user32.BringWindowToTop(hwnd)
                except Exception:
                    pass
        except Exception:
            # 不让抢焦点失败炸整个 timer 循环
            pass

    # 阻止用户按 Esc / Alt-F4 关掉 (这俩在 frameless 下本来也很难触发,
    # 但保险起见无视 close event 让 main.py 决定 hide)
    def closeEvent(self, event) -> None:  # type: ignore[override]
        event.ignore()

    def keyPressEvent(self, event) -> None:  # type: ignore[override]
        # 拒绝 Esc 关掉; 其它键正常 (按钮 focus 切换等)
        if event.key() == Qt.Key_Escape:
            event.ignore()
            return
        super().keyPressEvent(event)
