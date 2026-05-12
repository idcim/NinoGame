"""进程扫描 + 窗口枚举 → list[ProcessSnapshot]。

性能取舍 (重要, 见 P2 之后用户报告"打开 NinoGameAgent 电脑就卡"):

psutil.process_iter(['name']) 在 Windows 上每个进程都要 OpenProcess +
QueryFullProcessImageName 来拿 name → 400 进程 × 每 2s 一次 = OS 一直
被锤 (实测 1100ms / 次)。

改用 Windows Toolhelp32 API (CreateToolhelp32Snapshot + Process32NextW)
直接读 PEB 缓存的 szExeFile, **不开任何进程 handle**, 实测 ~10ms / 次
(118x 加速)。exe 全路径 (rule_engine 偶尔需要) 仍走 psutil + 缓存。
"""
from __future__ import annotations

import ctypes
import logging
import time
from ctypes import wintypes
from typing import Iterable

import psutil  # 仍用于 exe 全路径 + foreground 进程对象

from comms.message_types import ProcessSnapshot

_log = logging.getLogger(__name__)

try:
    import win32gui
    import win32process
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False
    print(
        "[NinoGame][WARN] pywin32 未安装：窗口标题匹配 + 前台进程检测都将失效。\n"
        "                 安装命令: pip install pywin32",
        flush=True,
    )


# ────────────────────────────────────────────────────────────────
# Toolhelp32 (快速进程枚举)
# ────────────────────────────────────────────────────────────────
_TH32CS_SNAPPROCESS = 0x00000002
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_MAX_PATH = 260


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * _MAX_PATH),
    ]


def _enumerate_processes_fast() -> list[tuple[int, str]]:
    """直接 ctypes 调 Toolhelp32, 不打开任何进程 handle。
    返回 [(pid, exe_name), ...]; 失败时返回 []。"""
    k32 = ctypes.windll.kernel32
    snap = k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if not snap or snap == _INVALID_HANDLE_VALUE:
        return []
    try:
        pe = _PROCESSENTRY32W()
        pe.dwSize = ctypes.sizeof(pe)
        out: list[tuple[int, str]] = []
        if k32.Process32FirstW(snap, ctypes.byref(pe)):
            while True:
                out.append((int(pe.th32ProcessID), pe.szExeFile))
                if not k32.Process32NextW(snap, ctypes.byref(pe)):
                    break
        return out
    finally:
        k32.CloseHandle(snap)


# ────────────────────────────────────────────────────────────────
# exe 路径缓存 (供 rule_engine + foreground 复用)
# ────────────────────────────────────────────────────────────────
_exe_cache: dict[int, str] = {}
_EXE_CACHE_MAX = 4096


def resolve_exe(pid: int) -> str:
    """按需查 exe 全路径 + 缓存; 拿不到返回 ""。"""
    cached = _exe_cache.get(pid)
    if cached is not None:
        return cached
    try:
        exe = psutil.Process(pid).exe() or ""
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        exe = ""
    except Exception:
        exe = ""
    if len(_exe_cache) >= _EXE_CACHE_MAX:
        # 简单回收: 删掉一半最旧的
        for k in list(_exe_cache.keys())[: _EXE_CACHE_MAX // 2]:
            _exe_cache.pop(k, None)
    _exe_cache[pid] = exe
    return exe


def _invalidate_dead_pids(alive_pids: set[int]) -> None:
    if not _exe_cache:
        return
    for pid in [p for p in _exe_cache if p not in alive_pids]:
        _exe_cache.pop(pid, None)


# ────────────────────────────────────────────────────────────────
# 窗口枚举
# ────────────────────────────────────────────────────────────────
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


# ────────────────────────────────────────────────────────────────
# 主扫描
# ────────────────────────────────────────────────────────────────
def scan_processes() -> list[ProcessSnapshot]:
    """一次完整扫描 (Toolhelp32 + EnumWindows, ~10ms)。

    exe_path 留空, rule_engine 真要按 exe 匹配时才调 resolve_exe(pid)。
    """
    pid_to_titles = get_window_titles_by_pid()
    raw = _enumerate_processes_fast()
    alive: set[int] = set()
    out: list[ProcessSnapshot] = []
    for pid, name in raw:
        alive.add(pid)
        out.append(ProcessSnapshot(
            pid=pid,
            name=name,
            exe_path="",
            window_titles=pid_to_titles.get(pid, []),
            command_line="",
        ))
    _invalidate_dead_pids(alive)
    return out


def scan_processes_timed() -> tuple[list[ProcessSnapshot], float]:
    """诊断用: 返回 (snaps, ms)。"""
    t0 = time.monotonic()
    snaps = scan_processes()
    return snaps, (time.monotonic() - t0) * 1000.0


# ────────────────────────────────────────────────────────────────
# 前台进程 (token_engine / overlay)
# ────────────────────────────────────────────────────────────────
def get_foreground_process_snapshot() -> ProcessSnapshot | None:
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
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return None
        return ProcessSnapshot(
            pid=pid,
            name=name,
            exe_path=resolve_exe(pid),  # 前台触发频率低, 直接缓存查
            window_titles=[title] if title else [],
        )
    except Exception:
        _log.exception("foreground snapshot failed")
        return None


def snapshots_by_name(snapshots: Iterable[ProcessSnapshot]) -> dict[str, list[ProcessSnapshot]]:
    out: dict[str, list[ProcessSnapshot]] = {}
    for s in snapshots:
        out.setdefault(s.name.lower(), []).append(s)
    return out
