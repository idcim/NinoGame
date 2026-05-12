"""资产路径解析。

开发态: agent/assets/...
PyInstaller --onefile: sys._MEIPASS/assets/...
"""
from __future__ import annotations

import sys
from pathlib import Path


def assets_dir() -> Path:
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    else:
        base = Path(__file__).resolve().parent.parent
    return base / "assets"


def logo_path() -> Path:
    return assets_dir() / "logo.png"


def tray_image_path() -> Path:
    return assets_dir() / "tray.png"


def dialog_image_path() -> Path:
    return assets_dir() / "dialog.png"


def ico_path() -> Path:
    return assets_dir() / "icon.ico"
