"""进程扫描 + 窗口枚举 → list[ProcessSnapshot]。

只负责"产生快照"，不知道有任何规则、不杀任何进程。
保留 P0 的成熟策略：白名单不在这里看（移到 rule_engine 的 exclude_processes 字段里）。
"""
from __future__ import annotations

import logging
from typing import Iterable

import psutil

from comms.message_types import ProcessSnapshot

_log = logging.getLogger(__name__)

try:
    import win32gui
    import win32process
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False
    # 这条信息在 main.py setup_logging 之前就会触发；
    # 走 print 而非 _log，避免被 Python 默认 lastResort handler 吞掉格式。
    print(
        "[NinoGame][WARN] pywin32 未安装：窗口标题匹配 + 前台进程检测都将失效。\n"
        "                 安装命令: pip install pywin32",
        flush=True,
    )


def get_window_titles_by_pid() -> dict[int, list[str]]:
    pid_to_titles: dict[int, list[str]] = {}
    if not HAS_WIN32:
        return pid_to_titles

    def _callback(hwnd, _ctx):
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title:
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
        except Exception:
            return
        pid_to_titles.setdefault(pid, []).append(title)

    try:
        win32gui.EnumWindows(_callback, None)
    except Exception:
        _log.exception("EnumWindows failed")
    return pid_to_titles


def scan_processes() -> list[ProcessSnapshot]:
    """一次完整扫描。"""
    pid_to_titles = get_window_titles_by_pid()
    out: list[ProcessSnapshot] = []
    for proc in psutil.process_iter(["pid", "name", "exe"]):
        try:
            info = proc.info
            pid = info["pid"]
            out.append(ProcessSnapshot(
                pid=pid,
                name=(info.get("name") or ""),
                exe_path=(info.get("exe") or ""),
                window_titles=pid_to_titles.get(pid, []),
                command_line="",  # P3 才需要
            ))
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        except Exception:
            _log.exception("psutil.process_iter item failed")
            continue
    return out


def get_foreground_process_snapshot() -> ProcessSnapshot | None:
    """当前前台窗口对应的进程 + 窗口标题。token_engine / activity_detector 用。"""
    if not HAS_WIN32:
        return None
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        title = win32gui.GetWindowText(hwnd) or ""
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        if not pid:
            return None
        try:
            p = psutil.Process(pid)
            name = p.name() or ""
            exe = p.exe() or ""
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return None
        return ProcessSnapshot(
            pid=pid,
            name=name,
            exe_path=exe,
            window_titles=[title] if title else [],
        )
    except Exception:
        _log.exception("foreground snapshot failed")
        return None


def snapshots_by_name(snapshots: Iterable[ProcessSnapshot]) -> dict[str, list[ProcessSnapshot]]:
    """便利函数：按进程名（小写）分组。"""
    out: dict[str, list[ProcessSnapshot]] = {}
    for s in snapshots:
        out.setdefault(s.name.lower(), []).append(s)
    return out
