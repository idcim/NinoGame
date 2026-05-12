"""单实例锁。

防止第二次双击 NinoGameAgent.exe / Watchdog.exe 产生重复进程。
重复进程会争抢心跳文件 / 端口 / SQLite 写, 后果不可控。

Windows 用命名 mutex (Local\\ 名字空间, 仅当前用户会话可见)。
其他平台无操作。
"""
from __future__ import annotations

import ctypes
import logging
import sys
from ctypes import wintypes

_log = logging.getLogger(__name__)

_ERROR_ALREADY_EXISTS = 183


class SingleInstanceLock:
    """获得锁返回 True; 已被占用返回 False (建议立即退出)。

    用法:
        lock = SingleInstanceLock("Local\\\\NinoGameAgent_v1")
        if not lock.acquire():
            print("已在运行")
            sys.exit(0)
        # 进程生命周期内 lock 不要释放
    """

    def __init__(self, name: str) -> None:
        self._name = name
        self._handle: int | None = None
        self._is_owner = False

    def acquire(self) -> bool:
        if sys.platform != "win32":
            # 非 Windows: 简单返回 True (P2 再做)
            return True
        try:
            k32 = ctypes.windll.kernel32
            k32.CreateMutexW.argtypes = [
                ctypes.c_void_p,  # lpMutexAttributes
                wintypes.BOOL,    # bInitialOwner
                wintypes.LPCWSTR, # lpName
            ]
            k32.CreateMutexW.restype = wintypes.HANDLE
            self._handle = k32.CreateMutexW(None, False, self._name)
            err = k32.GetLastError()
            if err == _ERROR_ALREADY_EXISTS:
                # 句柄拿到了 (重复打开)，关掉, 但不真"拥有"
                if self._handle:
                    k32.CloseHandle(self._handle)
                    self._handle = None
                return False
            self._is_owner = True
            return True
        except Exception:
            _log.exception("single instance lock 失败, 仍允许启动")
            return True

    def release(self) -> None:
        if self._handle and sys.platform == "win32":
            try:
                ctypes.windll.kernel32.CloseHandle(self._handle)
            except Exception:
                pass
            self._handle = None
            self._is_owner = False
