"""Watchdog 主入口逻辑（被 watchdog_main.py 调用）。

职责：
  - 自己也每 5s 写 data/watchdog.alive
  - 监视 data/agent.alive，>60s 没更新 → 拉起 Agent
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

_log = logging.getLogger(__name__)

_BEAT_INTERVAL = 5
_AGENT_TIMEOUT = 60


def run(
    data_dir: str | Path,
    agent_launch_cmd: list[str],
) -> None:
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    mine = data_dir / "watchdog.alive"
    peer = data_dir / "agent.alive"
    # 家长 PIN 通过后 Agent 退出会写这个 flag, 表示 "主动退出, 不要重启";
    # Watchdog 看到后自己也退出, 让"退出"是真退出而不是被 Watchdog 拉起重启。
    # Agent crash 时不会写 flag, Watchdog 仍按 stale 检测重启 (自保护不变)。
    quit_flag = data_dir / "agent_quit.flag"

    def _shutdown(_signum, _frame):
        _log.info("watchdog shutting down")
        sys.exit(0)

    if sys.platform == "win32":
        try:
            signal.signal(signal.SIGINT, _shutdown)
        except ValueError:
            pass
    else:
        signal.signal(signal.SIGTERM, _shutdown)
        signal.signal(signal.SIGINT, _shutdown)

    _log.info("watchdog started; pid=%s; peer cmd=%s", os.getpid(), agent_launch_cmd)
    while True:
        try:
            if quit_flag.exists():
                _log.info("看到 agent_quit.flag (Agent 主动退出), watchdog 一并退出")
                return
            _beat(mine)
            _check_agent(peer, agent_launch_cmd)
        except Exception:
            _log.exception("watchdog tick failed")
        time.sleep(_BEAT_INTERVAL)


def _beat(mine: Path) -> None:
    tmp = mine.with_suffix(mine.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(f"{os.getpid()}\n{int(time.time())}\n")
    os.replace(tmp, mine)


def _check_agent(peer: Path, agent_launch_cmd: list[str]) -> None:
    if not peer.exists():
        _relaunch(agent_launch_cmd, "agent alive file missing")
        return
    age = time.time() - peer.stat().st_mtime
    if age > _AGENT_TIMEOUT:
        _relaunch(agent_launch_cmd, f"agent stale ({age:.0f}s)")


def _relaunch(cmd: list[str], reason: str) -> None:
    _log.warning("relaunching agent: %s", reason)
    try:
        creationflags = 0x00000008 | 0x00000200 if sys.platform == "win32" else 0
        subprocess.Popen(
            cmd,
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
    except Exception:
        _log.exception("agent relaunch failed")
