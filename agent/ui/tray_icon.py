"""系统托盘 (§15.2)。

显示当前模式 + token 余额，提供最小操作菜单。
未装 pystray/Pillow 时跳过（不影响 monitor + killer 主链路）。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from comms.message_types import SessionMode

_log = logging.getLogger(__name__)

try:
    import pystray
    from PIL import Image, ImageDraw, ImageFont
    HAS_TRAY = True
except ImportError:
    HAS_TRAY = False
    # 用 print 走 stdout，避开 logging lastResort handler；
    # 这条会在 main 起 logging 之前触发。
    print(
        "[NinoGame][WARN] pystray / Pillow 未安装：托盘图标不可用。\n"
        "                 安装命令: pip install pystray Pillow",
        flush=True,
    )


def _balance_color(balance: int, daily_credit_cap: int) -> tuple[int, int, int]:
    if balance <= 0:
        return (220, 60, 60)        # 红
    ratio = balance / max(1, daily_credit_cap)
    if ratio < 0.25:
        return (230, 130, 50)       # 橙
    if ratio < 0.5:
        return (230, 200, 60)       # 黄
    return (90, 180, 100)           # 绿


def _render_icon(balance: int, mode: str, daily_credit_cap: int) -> "Image.Image":
    size = 64
    bg = (32, 32, 36) if mode != SessionMode.LOCK.value else (60, 60, 60)
    fg = _balance_color(balance, daily_credit_cap)
    img = Image.new("RGB", (size, size), bg)
    draw = ImageDraw.Draw(img)

    # 模式标记小条
    mode_color = {
        SessionMode.CHILD.value: (90, 180, 100),
        SessionMode.PARENT.value: (130, 130, 220),
        SessionMode.LOCK.value: (120, 120, 120),
        SessionMode.LIMITED_FREE.value: (230, 180, 60),
    }.get(mode, (90, 180, 100))
    draw.rectangle([(0, 0), (size, 6)], fill=mode_color)

    # 余额数字
    text = str(balance) if balance < 1000 else f"{balance // 100}H"
    try:
        font = ImageFont.truetype("arial.ttf", 28)
    except (OSError, IOError):
        font = ImageFont.load_default()
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except AttributeError:
        # 旧版 PIL
        tw, th = draw.textsize(text, font=font)
    draw.text(((size - tw) / 2, (size - th) / 2 + 4), text, fill=fg, font=font)
    return img


class TrayController:
    """托盘外壳。

    回调由外部注入：调用方决定 lock / resume / quit 的真实动作。
    """

    def __init__(
        self,
        get_balance: Callable[[], int],
        get_mode: Callable[[], str],
        get_daily_credit_cap: Callable[[], int],
        on_lock: Callable[[], None],
        on_resume: Callable[[], None],
        on_quit: Callable[[], None],
        get_checklist: Callable[[], list[tuple[object, bool]]] | None = None,
        on_check_tick: Callable[[str, bool], None] | None = None,
        refresh_seconds: int = 5,
    ) -> None:
        self._get_balance = get_balance
        self._get_mode = get_mode
        self._get_cap = get_daily_credit_cap
        self._on_lock = on_lock
        self._on_resume = on_resume
        self._on_quit = on_quit
        self._get_checklist = get_checklist
        self._on_check_tick = on_check_tick

        self._icon: "pystray.Icon | None" = None
        self._stop = threading.Event()
        self._refresh = refresh_seconds
        self._thread: threading.Thread | None = None

    # ── 启停 ─────────────────────────────────────────────────────
    def start(self) -> None:
        if not HAS_TRAY:
            return
        self._icon = pystray.Icon(
            "NinoGame",
            icon=self._render(),
            title=self._title(),
            menu=self._menu(),
        )
        self._stop.clear()
        # icon.run() 阻塞；放独立线程
        threading.Thread(target=self._icon.run, name="tray-icon", daemon=True).start()
        # 刷新线程
        self._thread = threading.Thread(
            target=self._refresh_loop, name="tray-refresh", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:
                pass

    # ── 渲染 ─────────────────────────────────────────────────────
    def _render(self) -> "Image.Image":
        return _render_icon(self._get_balance(), self._get_mode(), self._get_cap())

    def _title(self) -> str:
        mode = self._get_mode()
        bal = self._get_balance()
        return f"NinoGame · {mode} · 💎 {bal}"

    def _menu(self) -> "pystray.Menu":
        items = [
            pystray.MenuItem("Lock 现在", lambda icon, item: self._safe(self._on_lock)),
            pystray.MenuItem("解锁 (Child)", lambda icon, item: self._safe(self._on_resume)),
            pystray.Menu.SEPARATOR,
        ]
        if self._get_checklist is not None and self._on_check_tick is not None:
            for item, done in self._get_checklist():
                items.append(self._build_check_item(item.id, item.name, done))
            items.append(pystray.Menu.SEPARATOR)
        items.append(pystray.MenuItem("退出 (家长用)", lambda icon, item: self._safe(self._on_quit)))
        return pystray.Menu(*items)

    def _build_check_item(self, task_id: str, name: str, done: bool):
        # pystray 校验 callback 形参数量 == 2，所以不能用带默认值的 lambda；
        # 用闭包捕获 task_id / done。
        label = ("[x] " if done else "[ ] ") + name

        def _on_click(icon, item) -> None:
            self._safe(lambda: self._on_check_tick(task_id, not done))  # type: ignore[misc]

        return pystray.MenuItem(label, _on_click)

    def _refresh_loop(self) -> None:
        while not self._stop.is_set():
            time.sleep(self._refresh)
            if self._icon is None:
                continue
            try:
                self._icon.icon = self._render()
                self._icon.title = self._title()
                self._icon.menu = self._menu()
            except Exception:
                _log.exception("tray refresh failed")

    def _safe(self, fn: Callable[[], None]) -> None:
        try:
            fn()
        except Exception:
            _log.exception("tray callback failed")
