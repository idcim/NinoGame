"""自绘 Tkinter 弹窗。

设计目标：
  - 比 MessageBoxW 漂亮，与 logo 视觉一致
  - 不引入新依赖（Tkinter 是 stdlib）
  - WarningDialog: 非阻塞，调用方扔进后台
  - PinDialog: 阻塞，返回 (ok, attempted_pin)
  - 失败优雅降级到 logging（Service 模式无窗口站时）

视觉配色（取自 logo 的蓝绿渐变）：
  primary = #1ea7c4 蓝
  accent  = #66c596 绿
  bg      = #f5f9fb 浅底
  warn    = #d96a3c 橙
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable

_log = logging.getLogger(__name__)

# 颜色常量
COLOR_PRIMARY = "#1ea7c4"
COLOR_ACCENT = "#66c596"
COLOR_BG = "#f5f9fb"
COLOR_WARN = "#d96a3c"
COLOR_TEXT = "#1a3140"
COLOR_TEXT_DIM = "#6f8590"
COLOR_BUTTON_HOVER = "#1789a3"
COLOR_BORDER = "#dbe5eb"


# ────────────────────────────────────────────────────────────────
# 公共工具
# ────────────────────────────────────────────────────────────────
def _center(win, w: int, h: int) -> None:
    win.update_idletasks()
    sw = win.winfo_screenwidth()
    sh = win.winfo_screenheight()
    x = (sw - w) // 2
    y = (sh - h) // 3   # 略偏上更顺眼
    win.geometry(f"{w}x{h}+{x}+{y}")


def _load_logo_image(tk_root, asset_path: str | Path, size: int = 96):
    """返回 PhotoImage 或 None。Tk 8.6+ 支持 PNG 直读。"""
    try:
        import tkinter as tk  # noqa: F401
        from PIL import Image, ImageTk
    except ImportError:
        return None
    try:
        img = Image.open(str(asset_path)).convert("RGBA")
        img = img.resize((size, size), Image.LANCZOS)
        return ImageTk.PhotoImage(img, master=tk_root)
    except Exception:
        _log.exception("logo 加载失败 path=%s", asset_path)
        return None


def _apply_window_icon(root, png_path: str | Path | None) -> None:
    """设置 Tk 窗口标题栏 / 任务栏图标。

    用 iconphoto + PIL 直接加载 PNG，跨 Windows / Linux 都好使。
    PhotoImage 必须挂在 root 上防 GC。
    """
    if not png_path:
        return
    try:
        from PIL import Image, ImageTk
        img = Image.open(str(png_path)).convert("RGBA").resize((32, 32), Image.LANCZOS)
        photo = ImageTk.PhotoImage(img, master=root)
        root.iconphoto(False, photo)
        root._ninogame_icon_ref = photo  # 防 GC
    except Exception:
        _log.debug("iconphoto 设置失败 path=%s", png_path)


def _grab_focus(root, entry_widget=None) -> None:
    """从 pystray 线程 / 后台线程创建的 Tk 窗口需要主动夺焦点，
    否则用户看到窗口但 Entry 收不到键盘输入。

    顺序：
      1. update_idletasks → 让窗口被 map
      2. lift + focus_force
      3. 配合 Windows SetForegroundWindow (允许跨线程激活前台)
      4. entry.focus_set + 延迟再 set 一次（兜底）
    """
    try:
        root.update_idletasks()
        root.lift()
        root.attributes("-topmost", True)
        root.focus_force()
    except Exception:
        pass

    # Windows: 强制把窗口拉到前台。SetForegroundWindow 在某些条件下
    # 会被 OS 拒绝（只闪烁任务栏），但配合 lift+focus_force 通常成功。
    try:
        import sys
        if sys.platform == "win32":
            import ctypes
            hwnd = root.winfo_id()
            ctypes.windll.user32.SetForegroundWindow(hwnd)
    except Exception:
        pass

    if entry_widget is not None:
        try:
            entry_widget.focus_set()
        except Exception:
            pass

        def _delayed():
            try:
                if entry_widget.winfo_exists():
                    entry_widget.focus_force()
                    entry_widget.focus_set()
            except Exception:
                pass
        try:
            root.after(100, _delayed)
        except Exception:
            pass


# ────────────────────────────────────────────────────────────────
# Warning Dialog
# ────────────────────────────────────────────────────────────────
class WarningDialog:
    """非阻塞警告弹窗。

    用法:
        WarningDialog(
            title="NinoGame · 提醒",
            message="今日游戏时间已用完。",
            logo_path="assets/dialog.png",
            auto_close_seconds=8,
            accent=COLOR_WARN,
        ).show_async()
    """

    def __init__(
        self,
        title: str,
        message: str,
        logo_path: str | Path | None = None,
        button_text: str = "我知道了",
        auto_close_seconds: int = 0,
        accent: str = COLOR_WARN,
    ) -> None:
        self.title = title
        self.message = message
        self.logo_path = logo_path
        self.button_text = button_text
        self.auto_close_seconds = auto_close_seconds
        self.accent = accent

    def show_async(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        try:
            import tkinter as tk
        except ImportError:
            _log.warning("Tkinter 不可用，弹窗降级到日志: %s", self.message)
            return
        try:
            root = tk.Tk()
        except Exception:
            _log.warning("Tk 无法初始化（Service 模式?），降级到日志: %s", self.message)
            return

        try:
            self._build(root)
            root.mainloop()
        except Exception:
            _log.exception("WarningDialog 运行失败")
            try:
                root.destroy()
            except Exception:
                pass

    def _build(self, root) -> None:
        import tkinter as tk

        W, H = 420, 320
        root.title(self.title)
        root.configure(bg=COLOR_BG)
        root.resizable(False, False)
        root.attributes("-topmost", True)
        # 移除最大化按钮（仅留最小化 + 关闭）
        try:
            root.attributes("-toolwindow", False)
        except tk.TclError:
            pass
        _center(root, W, H)
        _apply_window_icon(root, self.logo_path)

        # 顶部 accent bar
        bar = tk.Frame(root, bg=self.accent, height=6)
        bar.pack(fill="x", side="top")

        body = tk.Frame(root, bg=COLOR_BG)
        body.pack(fill="both", expand=True, padx=24, pady=(20, 16))

        # logo
        self._logo_ref = _load_logo_image(root, self.logo_path, size=80) if self.logo_path else None
        if self._logo_ref is not None:
            tk.Label(body, image=self._logo_ref, bg=COLOR_BG).pack(pady=(0, 12))

        # 标题
        tk.Label(
            body,
            text=self.title,
            font=("Microsoft YaHei UI", 13, "bold"),
            fg=COLOR_TEXT,
            bg=COLOR_BG,
        ).pack(pady=(0, 8))

        # 正文
        tk.Label(
            body,
            text=self.message,
            font=("Microsoft YaHei UI", 10),
            fg=COLOR_TEXT,
            bg=COLOR_BG,
            wraplength=W - 80,
            justify="center",
        ).pack(pady=(0, 12))

        # 按钮
        self._countdown_label = None
        btn = tk.Button(
            body,
            text=self.button_text,
            font=("Microsoft YaHei UI", 10, "bold"),
            fg="white",
            bg=COLOR_PRIMARY,
            activebackground=COLOR_BUTTON_HOVER,
            activeforeground="white",
            relief="flat",
            padx=24,
            pady=6,
            cursor="hand2",
            command=root.destroy,
        )
        btn.pack(pady=(4, 0))

        # 自动关闭 + 倒计时
        if self.auto_close_seconds > 0:
            self._countdown_label = tk.Label(
                body,
                text="",
                font=("Microsoft YaHei UI", 8),
                fg=COLOR_TEXT_DIM,
                bg=COLOR_BG,
            )
            self._countdown_label.pack(pady=(8, 0))
            self._countdown_remaining = self.auto_close_seconds
            self._tick_countdown(root)

        # Esc / Enter 关闭
        root.bind("<Escape>", lambda _e: root.destroy())
        root.bind("<Return>", lambda _e: root.destroy())
        _grab_focus(root, btn)

    def _tick_countdown(self, root) -> None:
        if self._countdown_label is None:
            return
        try:
            if not root.winfo_exists():
                return
            if self._countdown_remaining <= 0:
                root.destroy()
                return
            self._countdown_label.config(
                text=f"{self._countdown_remaining} 秒后自动关闭"
            )
            self._countdown_remaining -= 1
            root.after(1000, lambda: self._tick_countdown(root))
        except Exception:
            pass


# ────────────────────────────────────────────────────────────────
# PIN Dialog（用于退出 / 切回 Child / 关键操作）
# ────────────────────────────────────────────────────────────────
class PinDialog:
    """阻塞 PIN 对话框。

    用法:
        ok = PinDialog(
            title="退出 NinoGame",
            prompt="请输入家长 PIN 才能退出监控。",
            logo_path="assets/dialog.png",
            verify=pin_manager.verify,
            on_wrong=lambda remaining: messages.get("quit_pin_wrong", remaining=remaining),
            on_locked=lambda mins: messages.get("quit_pin_locked", minutes=mins),
            is_locked=pin_manager.is_locked,
            seconds_until_unlock=pin_manager.seconds_until_unlock,
            max_attempts=3,
        ).ask()
    """

    def __init__(
        self,
        title: str,
        prompt: str,
        logo_path: str | Path | None,
        verify: Callable[[str], bool],
        on_wrong: Callable[[int], str],
        on_locked: Callable[[int], str],
        is_locked: Callable[[], bool],
        seconds_until_unlock: Callable[[], int],
        max_attempts: int = 3,
        confirm_text: str = "确认",
        cancel_text: str = "取消",
    ) -> None:
        self.title = title
        self.prompt = prompt
        self.logo_path = logo_path
        self._verify = verify
        self._on_wrong = on_wrong
        self._on_locked = on_locked
        self._is_locked = is_locked
        self._seconds_until_unlock = seconds_until_unlock
        self._max_attempts = max_attempts
        self.confirm_text = confirm_text
        self.cancel_text = cancel_text
        self._result = False

    def ask(self) -> bool:
        try:
            import tkinter as tk
        except ImportError:
            _log.warning("Tkinter 不可用，PIN 验证失败")
            return False
        try:
            root = tk.Tk()
        except Exception:
            _log.warning("Tk 无法初始化（Service 模式?），PIN 验证失败")
            return False
        try:
            self._build(root)
            root.mainloop()
        except Exception:
            _log.exception("PinDialog 运行失败")
            try:
                root.destroy()
            except Exception:
                pass
        return self._result

    def _build(self, root) -> None:
        import tkinter as tk

        W, H = 400, 340
        root.title(self.title)
        root.configure(bg=COLOR_BG)
        root.resizable(False, False)
        root.attributes("-topmost", True)
        _center(root, W, H)
        _apply_window_icon(root, self.logo_path)

        bar = tk.Frame(root, bg=COLOR_PRIMARY, height=6)
        bar.pack(fill="x", side="top")

        body = tk.Frame(root, bg=COLOR_BG)
        body.pack(fill="both", expand=True, padx=24, pady=(16, 16))

        self._logo_ref = _load_logo_image(root, self.logo_path, size=72) if self.logo_path else None
        if self._logo_ref is not None:
            tk.Label(body, image=self._logo_ref, bg=COLOR_BG).pack(pady=(0, 8))

        tk.Label(
            body,
            text=self.title,
            font=("Microsoft YaHei UI", 13, "bold"),
            fg=COLOR_TEXT,
            bg=COLOR_BG,
        ).pack(pady=(0, 6))

        tk.Label(
            body,
            text=self.prompt,
            font=("Microsoft YaHei UI", 9),
            fg=COLOR_TEXT_DIM,
            bg=COLOR_BG,
            wraplength=W - 80,
            justify="center",
        ).pack(pady=(0, 10))

        # PIN 输入框
        self._pin_var = tk.StringVar()
        entry = tk.Entry(
            body,
            textvariable=self._pin_var,
            show="•",
            font=("Consolas", 14),
            justify="center",
            relief="flat",
            highlightthickness=2,
            highlightcolor=COLOR_PRIMARY,
            highlightbackground=COLOR_BORDER,
            bg="white",
            fg=COLOR_TEXT,
        )
        entry.pack(fill="x", padx=20, pady=(0, 8), ipady=6)
        entry.focus_set()

        # 反馈区
        self._feedback = tk.Label(
            body,
            text="",
            font=("Microsoft YaHei UI", 9),
            fg=COLOR_WARN,
            bg=COLOR_BG,
        )
        self._feedback.pack(pady=(0, 8))

        # 按钮行
        btn_row = tk.Frame(body, bg=COLOR_BG)
        btn_row.pack(pady=(4, 0))

        cancel = tk.Button(
            btn_row,
            text=self.cancel_text,
            font=("Microsoft YaHei UI", 10),
            fg=COLOR_TEXT_DIM,
            bg=COLOR_BG,
            activebackground=COLOR_BG,
            relief="flat",
            padx=18,
            pady=6,
            cursor="hand2",
            command=root.destroy,
        )
        cancel.pack(side="left", padx=6)

        confirm = tk.Button(
            btn_row,
            text=self.confirm_text,
            font=("Microsoft YaHei UI", 10, "bold"),
            fg="white",
            bg=COLOR_PRIMARY,
            activebackground=COLOR_BUTTON_HOVER,
            activeforeground="white",
            relief="flat",
            padx=22,
            pady=6,
            cursor="hand2",
            command=lambda: self._on_confirm(root),
        )
        confirm.pack(side="left", padx=6)

        root.bind("<Return>", lambda _e: self._on_confirm(root))
        root.bind("<Escape>", lambda _e: root.destroy())

        # 进入时先看是否已锁
        self._check_locked_state(root, entry, confirm)

        # 从 pystray 线程创建的窗口默认拿不到键盘焦点 —— 强制抢
        _grab_focus(root, entry)

    def _check_locked_state(self, root, entry, confirm) -> None:
        if self._is_locked():
            mins = max(1, self._seconds_until_unlock() // 60)
            self._feedback.config(text=self._on_locked(mins))
            entry.config(state="disabled")
            confirm.config(state="disabled")

    def _on_confirm(self, root) -> None:
        pin = self._pin_var.get().strip()
        if not pin:
            self._feedback.config(text="请输入 PIN")
            return
        if self._is_locked():
            mins = max(1, self._seconds_until_unlock() // 60)
            self._feedback.config(text=self._on_locked(mins))
            return
        if self._verify(pin):
            self._result = True
            root.destroy()
            return

        # 错误
        if self._is_locked():
            mins = max(1, self._seconds_until_unlock() // 60)
            self._feedback.config(text=self._on_locked(mins))
        else:
            # max_attempts - 当前已失败次数；pin_manager 内部维护
            # 简化：直接显示"还剩 N 次" —— 由调用方通过 on_wrong 公式提供
            self._feedback.config(text=self._on_wrong(self._max_attempts))
        self._pin_var.set("")


# ────────────────────────────────────────────────────────────────
# Confirm Dialog（无 PIN 的简单退出确认）
# ────────────────────────────────────────────────────────────────
class ConfirmDialog:
    """普通 Yes/No 确认。"""

    def __init__(
        self,
        title: str,
        message: str,
        logo_path: str | Path | None,
        confirm_text: str = "确认",
        cancel_text: str = "取消",
        accent: str = COLOR_PRIMARY,
    ) -> None:
        self.title = title
        self.message = message
        self.logo_path = logo_path
        self.confirm_text = confirm_text
        self.cancel_text = cancel_text
        self.accent = accent
        self._result = False

    def ask(self) -> bool:
        try:
            import tkinter as tk
        except ImportError:
            return False
        try:
            root = tk.Tk()
        except Exception:
            return False
        try:
            self._build(root)
            root.mainloop()
        except Exception:
            _log.exception("ConfirmDialog 运行失败")
            try:
                root.destroy()
            except Exception:
                pass
        return self._result

    def _build(self, root) -> None:
        import tkinter as tk

        W, H = 400, 300
        root.title(self.title)
        root.configure(bg=COLOR_BG)
        root.resizable(False, False)
        root.attributes("-topmost", True)
        _center(root, W, H)
        _apply_window_icon(root, self.logo_path)

        tk.Frame(root, bg=self.accent, height=6).pack(fill="x", side="top")

        body = tk.Frame(root, bg=COLOR_BG)
        body.pack(fill="both", expand=True, padx=24, pady=(16, 16))

        self._logo_ref = _load_logo_image(root, self.logo_path, size=72) if self.logo_path else None
        if self._logo_ref is not None:
            tk.Label(body, image=self._logo_ref, bg=COLOR_BG).pack(pady=(0, 8))

        tk.Label(
            body, text=self.title,
            font=("Microsoft YaHei UI", 13, "bold"),
            fg=COLOR_TEXT, bg=COLOR_BG,
        ).pack(pady=(0, 6))

        tk.Label(
            body, text=self.message,
            font=("Microsoft YaHei UI", 10),
            fg=COLOR_TEXT, bg=COLOR_BG,
            wraplength=W - 60, justify="center",
        ).pack(pady=(0, 14))

        btn_row = tk.Frame(body, bg=COLOR_BG)
        btn_row.pack()

        tk.Button(
            btn_row, text=self.cancel_text,
            font=("Microsoft YaHei UI", 10),
            fg=COLOR_TEXT_DIM, bg=COLOR_BG,
            activebackground=COLOR_BG, relief="flat",
            padx=18, pady=6, cursor="hand2",
            command=root.destroy,
        ).pack(side="left", padx=6)

        def _confirm() -> None:
            self._result = True
            root.destroy()

        confirm_btn = tk.Button(
            btn_row, text=self.confirm_text,
            font=("Microsoft YaHei UI", 10, "bold"),
            fg="white", bg=self.accent,
            activebackground=COLOR_BUTTON_HOVER, activeforeground="white",
            relief="flat", padx=22, pady=6, cursor="hand2",
            command=_confirm,
        )
        confirm_btn.pack(side="left", padx=6)

        root.bind("<Escape>", lambda _e: root.destroy())
        root.bind("<Return>", lambda _e: _confirm())

        _grab_focus(root, confirm_btn)
