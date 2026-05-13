"""Qt 弹窗的跨线程桥接。

工作线程（pystray / token_engine / killer）通过 bridge emit 信号；
信号在 GUI 主线程的槽里执行，弹窗就被创建在主线程 = 拥有键盘焦点。

PinDialog 是阻塞的：worker emit 后等 threading.Event。
WarningDialog 不阻塞：worker emit 完就走。
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Callable

from PySide6.QtCore import QObject, Signal, Slot

from ui.qt_dialogs import (
    COLOR_PRIMARY,
    COLOR_WARN,
    ConfirmDialog,
    PinDialog,
    WarningDialog,
)
from ui.pair_dialog import PairDialog

_log = logging.getLogger(__name__)


@dataclass
class _WarningRequest:
    title: str
    message: str
    logo_path: str | None
    button_text: str
    auto_close_seconds: int
    accent: str


@dataclass
class _PinRequest:
    title: str
    prompt: str
    logo_path: str | None
    verify: Callable[[str], bool]
    on_wrong: Callable[[int], str]
    on_locked: Callable[[int], str]
    is_locked: Callable[[], bool]
    seconds_until_unlock: Callable[[], int]
    max_attempts: int
    confirm_text: str
    cancel_text: str
    result: dict = field(default_factory=lambda: {"ok": False})
    done: threading.Event = field(default_factory=threading.Event)


@dataclass
class _ConfirmRequest:
    title: str
    message: str
    logo_path: str | None
    confirm_text: str
    cancel_text: str
    accent: str
    result: dict = field(default_factory=lambda: {"ok": False})
    done: threading.Event = field(default_factory=threading.Event)


@dataclass
class _PairRequest:
    settings_path: str
    logo_path: str | None
    current_url: str
    on_done: Callable[[bool, str, str], None]


class DialogBridge(QObject):
    """活在 GUI 主线程上的 QObject。"""

    _warning_signal = Signal(object)
    _pin_signal = Signal(object)
    _confirm_signal = Signal(object)
    _pair_signal = Signal(object)
    _quit_signal = Signal()

    # 复用同一个 PairDialog 实例 (避免每次开新窗口)
    _pair_dialog: PairDialog | None = None

    def __init__(self) -> None:
        super().__init__()
        self._warning_signal.connect(self._on_warning)
        self._pin_signal.connect(self._on_pin)
        self._confirm_signal.connect(self._on_confirm)
        self._pair_signal.connect(self._on_pair)

    # ── 槽: 在 GUI 线程上跑 ────────────────────────────────────
    @Slot(object)
    def _on_warning(self, req: _WarningRequest) -> None:
        try:
            d = WarningDialog(
                title=req.title,
                message=req.message,
                logo_path=req.logo_path,
                button_text=req.button_text,
                auto_close_seconds=req.auto_close_seconds,
                accent_color=req.accent,
            )
            d.show()
        except Exception:
            _log.exception("WarningDialog 创建失败")

    @Slot(object)
    def _on_pin(self, req: _PinRequest) -> None:
        try:
            d = PinDialog(
                title=req.title,
                prompt=req.prompt,
                logo_path=req.logo_path,
                verify=req.verify,
                on_wrong=req.on_wrong,
                on_locked=req.on_locked,
                is_locked=req.is_locked,
                seconds_until_unlock=req.seconds_until_unlock,
                max_attempts=req.max_attempts,
                confirm_text=req.confirm_text,
                cancel_text=req.cancel_text,
            )
            d.exec()
            req.result["ok"] = bool(d.result_ok)
        except Exception:
            _log.exception("PinDialog 创建失败")
        finally:
            req.done.set()

    @Slot(object)
    def _on_pair(self, req: _PairRequest) -> None:
        try:
            if self._pair_dialog is None:
                self._pair_dialog = PairDialog(
                    settings_path=req.settings_path,
                    logo_path=req.logo_path,
                    on_done=req.on_done,
                    current_url=req.current_url,
                )
            else:
                # 已有窗口: 更新 URL 提示 + on_done 回调 (可能切换了)
                try:
                    self._pair_dialog._url_input.setText(req.current_url)  # noqa: SLF001
                except Exception:
                    pass
                self._pair_dialog._on_done = req.on_done  # noqa: SLF001
            self._pair_dialog.show()
            self._pair_dialog.raise_()
            self._pair_dialog.activateWindow()
        except Exception:
            _log.exception("PairDialog 显示失败")

    @Slot(object)
    def _on_confirm(self, req: _ConfirmRequest) -> None:
        try:
            d = ConfirmDialog(
                title=req.title,
                message=req.message,
                logo_path=req.logo_path,
                confirm_text=req.confirm_text,
                cancel_text=req.cancel_text,
                accent_color=req.accent,
            )
            from PySide6.QtWidgets import QDialog
            req.result["ok"] = (d.exec() == QDialog.Accepted)
        except Exception:
            _log.exception("ConfirmDialog 创建失败")
        finally:
            req.done.set()

    # ── 对外: worker 线程调用 ───────────────────────────────────
    def show_warning(
        self,
        title: str,
        message: str,
        logo_path: str | None = None,
        button_text: str = "我知道了",
        auto_close_seconds: int = 0,
        accent: str = COLOR_WARN,
    ) -> None:
        self._warning_signal.emit(_WarningRequest(
            title=title, message=message, logo_path=logo_path,
            button_text=button_text, auto_close_seconds=auto_close_seconds,
            accent=accent,
        ))

    def ask_pin(
        self,
        title: str,
        prompt: str,
        logo_path: str | None,
        verify: Callable[[str], bool],
        on_wrong: Callable[[int], str],
        on_locked: Callable[[int], str],
        is_locked: Callable[[], bool],
        seconds_until_unlock: Callable[[], int],
        max_attempts: int = 3,
        confirm_text: str = "确认",
        cancel_text: str = "取消",
    ) -> bool:
        req = _PinRequest(
            title=title, prompt=prompt, logo_path=logo_path,
            verify=verify, on_wrong=on_wrong, on_locked=on_locked,
            is_locked=is_locked, seconds_until_unlock=seconds_until_unlock,
            max_attempts=max_attempts,
            confirm_text=confirm_text, cancel_text=cancel_text,
        )
        self._pin_signal.emit(req)
        req.done.wait()
        return bool(req.result["ok"])

    def show_pair_dialog(
        self,
        settings_path: str,
        logo_path: str | None,
        current_url: str,
        on_done: Callable[[bool, str, str], None],
    ) -> None:
        """worker 线程调; 信号派发到 GUI 主线程创建 + 显示 PairDialog。
        非阻塞 (PairDialog 用户填写期间, 工作线程不被 hold)。"""
        self._pair_signal.emit(_PairRequest(
            settings_path=settings_path,
            logo_path=logo_path,
            current_url=current_url,
            on_done=on_done,
        ))

    def ask_confirm(
        self,
        title: str,
        message: str,
        logo_path: str | None = None,
        confirm_text: str = "确认",
        cancel_text: str = "取消",
        accent: str = COLOR_PRIMARY,
    ) -> bool:
        req = _ConfirmRequest(
            title=title, message=message, logo_path=logo_path,
            confirm_text=confirm_text, cancel_text=cancel_text, accent=accent,
        )
        self._confirm_signal.emit(req)
        req.done.wait()
        return bool(req.result["ok"])

    @property
    def quit_signal(self) -> Signal:
        return self._quit_signal


# 单例
_bridge: DialogBridge | None = None


def init_bridge() -> DialogBridge:
    """在 GUI 主线程上调用一次。"""
    global _bridge
    if _bridge is None:
        _bridge = DialogBridge()
    return _bridge


def get_bridge() -> DialogBridge:
    if _bridge is None:
        raise RuntimeError("DialogBridge 未初始化；先在主线程调用 init_bridge()")
    return _bridge
