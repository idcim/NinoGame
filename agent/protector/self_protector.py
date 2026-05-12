"""Agent 侧守护：定期心跳到 data/agent.alive 文件 + 监视 watchdog。

策略：
  - 写 pid + 时间戳到 data/agent.alive，watchdog 监视该文件
  - 反向监视 data/watchdog.alive，若 60s 未更新，拉起 Watchdog.exe
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

_log = logging.getLogger(__name__)

_HEARTBEAT_INTERVAL = 5  # 秒
_PEER_TIMEOUT = 60        # 秒，对端无心跳视为挂掉


class SelfProtector:
    def __init__(
        self,
        my_alive_file: str | Path,
        peer_alive_file: str | Path,
        peer_launch_cmd: list[str] | None = None,
    ) -> None:
        self._mine = Path(my_alive_file)
        self._peer = Path(peer_alive_file)
        self._peer_launch = peer_launch_cmd or []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._mine.parent.mkdir(parents=True, exist_ok=True)
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="self-protector", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._beat()
                self._check_peer()
            except Exception:
                _log.exception("self-protector tick failed")
            self._stop.wait(_HEARTBEAT_INTERVAL)

    def _beat(self) -> None:
        try:
            tmp = self._mine.with_suffix(self._mine.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(f"{os.getpid()}\n{int(time.time())}\n")
            os.replace(tmp, self._mine)
        except Exception:
            _log.exception("write alive file failed")

    def _check_peer(self) -> None:
        if not self._peer_launch:
            return
        if not self._peer.exists():
            self._relaunch_peer("peer alive file missing")
            return
        try:
            mtime = self._peer.stat().st_mtime
            age = time.time() - mtime
        except OSError:
            self._relaunch_peer("peer alive file unreadable")
            return
        if age > _PEER_TIMEOUT:
            self._relaunch_peer(f"peer stale ({age:.0f}s)")

    def _relaunch_peer(self, reason: str) -> None:
        _log.warning("relaunching peer: %s; cmd=%s", reason, self._peer_launch)
        try:
            # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            creationflags = 0x00000008 | 0x00000200 if sys.platform == "win32" else 0
            subprocess.Popen(
                self._peer_launch,
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
            )
        except Exception:
            _log.exception("peer relaunch failed")
