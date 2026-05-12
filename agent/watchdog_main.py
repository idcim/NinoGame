"""Watchdog 入口。负责拉起 / 重启 Agent。

打包后：可执行旁边 NinoGameAgent.exe
开发态：python agent/main.py
"""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path


def _resolve_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _setup_logging(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] watchdog: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not root.handlers:
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        root.addHandler(sh)
        fh = RotatingFileHandler(
            log_dir / "watchdog.log",
            maxBytes=2 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        fh.setFormatter(fmt)
        root.addHandler(fh)


def _agent_cmd(root: Path) -> list[str]:
    if getattr(sys, "frozen", False):
        peer = root / "NinoGameAgent.exe"
        return [str(peer)]
    return [sys.executable, str(root / "main.py")]


_INSTANCE_LOCK_NAME = "Local\\NinoGameWatchdog_SingleInstance_v1"


def main() -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from protector.single_instance import SingleInstanceLock  # noqa: E402

    instance_lock = SingleInstanceLock(_INSTANCE_LOCK_NAME)
    if not instance_lock.acquire():
        print("[NinoGame] Watchdog 已在运行, 本次启动退出。", flush=True)
        return 0

    root = _resolve_root()
    data_dir = root / "data"
    log_dir = data_dir / "logs"
    _setup_logging(log_dir)

    from protector.watchdog import run as run_watchdog  # noqa: E402
    try:
        run_watchdog(data_dir=data_dir, agent_launch_cmd=_agent_cmd(root))
    finally:
        instance_lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
