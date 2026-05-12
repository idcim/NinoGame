"""NinoGame Agent 入口。

数据流（一个 tick）：
    monitor.scan_processes()
        ↓
    rule_engine.evaluate(rules)
        ↓
    killer.handle(matches)
    （并行）
    token_engine 每 60s 自跑：foreground → classifier → wallet → segment
    session_manager 每 30s 自跑：闲置检测 → mode 切换
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

# 允许从 agent/ 目录直接 import
_AGENT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_AGENT_DIR))

from comms.event_bus import default_bus  # noqa: E402
from comms.message_types import SessionEndReason, SessionMode  # noqa: E402
from comms.null_transport import NullTransport  # noqa: E402
from core.activity_detector import ActivityDetector  # noqa: E402
from core.checklist import ResponsibilityChecklist  # noqa: E402
from core.classifier import Classifier  # noqa: E402
from core.killer import Killer  # noqa: E402
from core.monitor import get_foreground_process_snapshot, scan_processes  # noqa: E402
from core.rule_engine import evaluate  # noqa: E402
from core.session_manager import SessionManager  # noqa: E402
from core.token_engine import TokenEngine, TokenEngineConfig  # noqa: E402
from protector.pin_manager import PinManager  # noqa: E402
from protector.self_protector import SelfProtector  # noqa: E402
from store.local_sqlite import (  # noqa: E402
    JsonRuleRepository,
    SqliteAppCategoryRepository,
    SqliteEventSink,
    SqliteResponsibilityRepository,
    SqliteSessionRepository,
    SqliteUnknownAppQueue,
    SqliteWalletService,
    open_db,
)
from store.seed_data import seed_app_categories_into_db, write_config_files  # noqa: E402
from ui.notifier import Notifier  # noqa: E402
from ui.tray_icon import TrayController  # noqa: E402

_log = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────────
# 路径
# ────────────────────────────────────────────────────────────────
def _resolve_root() -> Path:
    """支持开发态 (G:/DEL_GAME/agent) 和 PyInstaller --onefile。"""
    if getattr(sys, "frozen", False):
        # 打包后：可执行旁边的 data/ + config/
        return Path(sys.executable).resolve().parent
    # 开发态：repo 根目录 = agent/ 的父级，data/config 放在 agent/ 旁边
    return _AGENT_DIR


def _setup_logging(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not root.handlers:
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        sh.setLevel(logging.INFO)
        root.addHandler(sh)

        fh = RotatingFileHandler(
            log_dir / "agent.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        fh.setFormatter(fmt)
        fh.setLevel(logging.INFO)
        root.addHandler(fh)


# ────────────────────────────────────────────────────────────────
# Settings 读
# ────────────────────────────────────────────────────────────────
def _read_settings(settings_path: Path) -> dict:
    if not settings_path.exists():
        return {}
    with open(settings_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ────────────────────────────────────────────────────────────────
# 主组装
# ────────────────────────────────────────────────────────────────
class Agent:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.config_dir = root / "config"
        self.data_dir = root / "data"
        self.log_dir = self.data_dir / "logs"

        _setup_logging(self.log_dir)
        write_config_files(self.config_dir, overwrite=False)
        self.settings = _read_settings(self.config_dir / "settings.json")
        overrides = self.settings.get("quota_overrides", {})

        # 数据
        self.db = open_db(self.data_dir / "ninogame.db")
        self.rules_repo = JsonRuleRepository(self.config_dir / "rules.json")
        self.app_categories = SqliteAppCategoryRepository(self.db)
        self.wallet = SqliteWalletService(self.db)
        self.events = SqliteEventSink(self.db)
        self.sessions_repo = SqliteSessionRepository(self.db)
        self.unknown_queue = SqliteUnknownAppQueue(self.db)
        self.resp_repo = SqliteResponsibilityRepository(self.db)
        seed_app_categories_into_db(self.app_categories)

        # 通信
        self.bus = default_bus()
        self.transport = NullTransport()  # P2 换 WebSocketTransport

        # 业务
        self.notifier = Notifier(default_title="NinoGame")
        self.activity = ActivityDetector(
            strict_window=int(self.settings.get("activity_min_event_window_seconds", 60)),
            consumption_window=int(self.settings.get("consumption_active_window_seconds", 120)),
        )
        self.classifier = Classifier(self.app_categories, self.unknown_queue, self.events)
        self.killer = Killer(self.events, self.bus, self.notifier)
        self.session_manager = SessionManager(
            self.sessions_repo, self.events, self.bus, self.activity,
            idle_lock_minutes=int(self.settings.get("idle_lock_minutes", 10)),
        )
        self.token_engine = TokenEngine(
            config=TokenEngineConfig(
                billing_tick_seconds=int(self.settings.get("billing_tick_seconds", 60)),
                daily_hard_cap_minutes=int(overrides.get("daily_hard_cap_minutes", 120)),
                daily_credit_cap=int(overrides.get("daily_credit_cap", 120)),
                token_to_minute_ratio=float(self.settings.get("token_to_minute_ratio", 1.0)),
            ),
            get_foreground=get_foreground_process_snapshot,
            classifier=self.classifier,
            wallet=self.wallet,
            sessions=self.sessions_repo,
            events=self.events,
            bus=self.bus,
            notifier=self.notifier,
            activity=self.activity,
            get_active_session_id=self.session_manager.active_session_id,
        )
        self.checklist = ResponsibilityChecklist(
            self.config_dir / "tasks.json", self.resp_repo, self.events, self.bus
        )
        self.pin = PinManager(self.config_dir / "settings.json", self.events, self.bus)

        # 自保护
        self.self_protector = SelfProtector(
            my_alive_file=self.data_dir / "agent.alive",
            peer_alive_file=self.data_dir / "watchdog.alive",
            peer_launch_cmd=self._peer_launch_cmd(),
        )

        # 托盘
        self.tray = TrayController(
            get_balance=self.wallet.get_balance,
            get_mode=lambda: self.session_manager.mode,
            get_daily_credit_cap=lambda: int(overrides.get("daily_credit_cap", 120)),
            on_lock=lambda: self.session_manager.change_mode(
                SessionMode.LOCK.value, SessionEndReason.MANUAL_LOCK.value
            ),
            on_resume=lambda: self.session_manager.change_mode(
                SessionMode.CHILD.value, SessionEndReason.SWITCHED.value
            ),
            on_quit=self._request_quit,
            get_checklist=self.checklist.list_today,
            on_check_tick=self.checklist.tick,
        )

        self._stop = False

    def _peer_launch_cmd(self) -> list[str]:
        # 打包后：同目录的 Watchdog.exe
        if getattr(sys, "frozen", False):
            peer = Path(sys.executable).resolve().parent / "Watchdog.exe"
            if peer.exists():
                return [str(peer)]
            return []
        # 开发态：python watchdog_main.py
        return [sys.executable, str(_AGENT_DIR / "watchdog_main.py")]

    def _request_quit(self) -> None:
        _log.info("quit requested from tray")
        self._stop = True

    # ── 启动 / 主循环 ────────────────────────────────────────────
    def run(self) -> None:
        _log.info("Agent starting; root=%s", self.root)

        # 日发放
        from datetime import date as _date
        base = self._today_base_grant()
        granted = self.wallet.ensure_daily_grant(base, _date.today())
        if granted:
            _log.info("daily grant: +%d token", granted)

        self.activity.start()
        self.session_manager.start(initial_mode=self._initial_mode())
        self.token_engine.start()
        self.self_protector.start()
        self.tray.start()

        scan_interval = int(self.settings.get("monitor_scan_interval_seconds", 2))
        _log.info("Agent ready; scan_interval=%ds", scan_interval)

        # 主循环：规则评估 + 拦截
        self._install_signal_handlers()
        while not self._stop:
            try:
                self.rules_repo.reload_if_changed()
                snaps = scan_processes()
                rules = self.rules_repo.get_all()
                matches = evaluate(snaps, rules)
                if matches:
                    self.killer.handle(matches)
            except KeyboardInterrupt:
                break
            except Exception:
                _log.exception("scan loop iteration failed")
            time.sleep(scan_interval)

        self._shutdown()

    def _today_base_grant(self) -> int:
        from datetime import date as _date
        overrides = self.settings.get("quota_overrides", {})
        is_weekend = _date.today().weekday() >= 5
        if is_weekend:
            return int(overrides.get("weekend_base_tokens", 90))
        return int(overrides.get("weekday_base_tokens", 30))

    def _initial_mode(self) -> str:
        device_type = self.settings.get("device_type", "child_primary")
        if device_type == "shared":
            return SessionMode.LOCK.value
        if device_type == "parent_primary":
            return SessionMode.PARENT.value
        return SessionMode.CHILD.value

    def _install_signal_handlers(self) -> None:
        def _handler(_signum, _frame):
            _log.info("signal received; shutting down")
            self._stop = True

        try:
            signal.signal(signal.SIGINT, _handler)
            if sys.platform != "win32":
                signal.signal(signal.SIGTERM, _handler)
        except ValueError:
            pass

    def _shutdown(self) -> None:
        _log.info("Agent shutdown sequence")
        try:
            self.tray.stop()
        except Exception:
            pass
        try:
            self.token_engine.stop()
        except Exception:
            pass
        try:
            self.session_manager.stop()
        except Exception:
            pass
        try:
            self.self_protector.stop()
        except Exception:
            pass
        try:
            self.activity.stop()
        except Exception:
            pass
        try:
            self.db.close()
        except Exception:
            pass
        _log.info("Agent exited")


def main() -> int:
    root = _resolve_root()
    Agent(root).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
