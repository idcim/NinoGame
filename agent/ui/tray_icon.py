"""系统托盘 (§15.2)。

显示当前模式 + token 余额，提供最小操作菜单。
"退出"项走 PIN 校验流程（如果家长设过 PIN）；未设 PIN 时给确认对话框。
未装 pystray/Pillow 时跳过（不影响 monitor + killer 主链路）。
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Callable

from comms.message_types import SessionMode

_log = logging.getLogger(__name__)

try:
    import pystray
    from PIL import Image, ImageDraw, ImageFont
    HAS_TRAY = True
except ImportError:
    HAS_TRAY = False
    print(
        "[NinoGame][WARN] pystray / Pillow 未安装：托盘图标不可用。\n"
        "                 安装命令: pip install pystray Pillow",
        flush=True,
    )


# ────────────────────────────────────────────────────────────────
# 托盘图标绘制：在 logo 之上叠余额数字
# ────────────────────────────────────────────────────────────────
def _balance_color(balance: int, daily_credit_cap: int) -> tuple[int, int, int]:
    if balance <= 0:
        return (220, 60, 60)
    ratio = balance / max(1, daily_credit_cap)
    if ratio < 0.25:
        return (230, 130, 50)
    if ratio < 0.5:
        return (230, 200, 60)
    return (90, 180, 100)


def _load_base_image(path: str | Path | None) -> "Image.Image | None":
    if not path or not HAS_TRAY:
        return None
    try:
        img = Image.open(str(path)).convert("RGBA")
        return img.resize((64, 64), Image.LANCZOS)
    except Exception:
        _log.exception("tray base 图加载失败 path=%s", path)
        return None


def _render_icon(
    balance: int,
    mode: str,
    daily_credit_cap: int,
    base: "Image.Image | None",
) -> "Image.Image":
    size = 64

    if base is not None:
        img = base.copy()
    else:
        # 兜底：纯色方块（不应走到这里，除非 assets 缺失）
        bg = (32, 32, 36) if mode != SessionMode.LOCK.value else (60, 60, 60)
        img = Image.new("RGBA", (size, size), bg + (255,))

    draw = ImageDraw.Draw(img)

    # 模式色顶条
    mode_color = {
        SessionMode.CHILD.value: (90, 180, 100, 255),
        SessionMode.PARENT.value: (130, 130, 220, 255),
        SessionMode.LOCK.value: (140, 140, 140, 255),
        SessionMode.LIMITED_FREE.value: (230, 180, 60, 255),
    }.get(mode, (90, 180, 100, 255))
    draw.rectangle([(0, 0), (size, 5)], fill=mode_color)

    # 右下角余额徽章
    text = str(balance) if balance < 1000 else f"{balance // 100}H"
    try:
        font = ImageFont.truetype("arial.ttf", 18)
    except (OSError, IOError):
        font = ImageFont.load_default()
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
    except AttributeError:
        tw, th = draw.textsize(text, font=font)
    pad = 2
    box_w = tw + pad * 2 + 4
    box_h = th + pad * 2 + 2
    x1 = size - box_w - 2
    y1 = size - box_h - 2
    fg = _balance_color(balance, daily_credit_cap)
    # 半透明白底
    draw.rectangle(
        [(x1, y1), (x1 + box_w, y1 + box_h)],
        fill=(255, 255, 255, 220),
        outline=fg + (255,),
        width=1,
    )
    draw.text(
        (x1 + (box_w - tw) // 2 - 1, y1 + (box_h - th) // 2 - 2),
        text,
        fill=fg + (255,),
        font=font,
    )
    return img


# ────────────────────────────────────────────────────────────────
# TrayController
# ────────────────────────────────────────────────────────────────
class TrayController:
    """托盘外壳。

    退出走 quit_handler 注入（一般是 PIN 校验后再调原 on_quit）。
    """

    def __init__(
        self,
        get_balance: Callable[[], int],
        get_mode: Callable[[], str],
        get_daily_credit_cap: Callable[[], int],
        on_lock: Callable[[], None],
        on_resume: Callable[[], None],
        on_quit_request: Callable[[], None],
        get_checklist: Callable[[], list[tuple[object, bool]]] | None = None,
        on_check_tick: Callable[[str, bool], None] | None = None,
        get_tooltip: Callable[[], str] | None = None,
        tray_image_path: str | Path | None = None,
        refresh_seconds: int = 5,
    ) -> None:
        self._get_balance = get_balance
        self._get_mode = get_mode
        self._get_cap = get_daily_credit_cap
        self._on_lock = on_lock
        self._on_resume = on_resume
        self._on_quit_request = on_quit_request  # 注意：含 PIN 校验，不一定真退
        self._get_checklist = get_checklist
        self._on_check_tick = on_check_tick
        self._get_tooltip = get_tooltip

        self._base_image = _load_base_image(tray_image_path)

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
        threading.Thread(target=self._icon.run, name="tray-icon", daemon=True).start()
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
        return _render_icon(
            self._get_balance(),
            self._get_mode(),
            self._get_cap(),
            self._base_image,
        )

    def _title(self) -> str:
        if self._get_tooltip is not None:
            try:
                return self._get_tooltip()
            except Exception:
                pass
        mode = self._get_mode()
        bal = self._get_balance()
        return f"NinoGame · {mode} · {bal} token"

    def _menu(self) -> "pystray.Menu":
        items = [
            pystray.MenuItem("锁定", lambda icon, item: self._safe(self._on_lock)),
            pystray.MenuItem("回到 Child 模式", lambda icon, item: self._safe(self._on_resume)),
            pystray.Menu.SEPARATOR,
        ]
        if self._get_checklist is not None and self._on_check_tick is not None:
            for item, done in self._get_checklist():
                items.append(self._build_check_item(item.id, item.name, done))
            items.append(pystray.Menu.SEPARATOR)
        items.append(
            pystray.MenuItem("退出（需家长 PIN）", lambda icon, item: self._safe(self._on_quit_request))
        )
        return pystray.Menu(*items)

    def _build_check_item(self, task_id: str, name: str, done: bool):
        label = ("[x] " if done else "[ ] ") + name

        def _on_click(icon, item) -> None:
            self._safe(lambda: self._on_check_tick(task_id, not done))

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
