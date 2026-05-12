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
from core.messages import Messages  # noqa: E402
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
from ui.assets import (  # noqa: E402
    dialog_image_path,
    tray_image_path,
)
from ui.notifier import Notifier  # noqa: E402
from ui.qt_bridge import get_bridge, init_bridge  # noqa: E402
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
        self.messages = Messages(self.config_dir / "settings.json")
        self.notifier = Notifier(
            default_title=self.messages.get("block_dialog_title"),
            logo_path=str(dialog_image_path()) if dialog_image_path().exists() else None,
            auto_close_seconds=int(self.settings.get("warning_dialog_auto_close_seconds", 0)),
        )
        self.activity = ActivityDetector(
            strict_window=int(self.settings.get("activity_min_event_window_seconds", 60)),
            consumption_window=int(self.settings.get("consumption_active_window_seconds", 120)),
        )
        self.classifier = Classifier(self.app_categories, self.unknown_queue, self.events)
        self.killer = Killer(self.events, self.bus, self.notifier, self.messages)
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
            messages=self.messages,
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
            on_quit_request=self._handle_quit_request,
            get_checklist=self.checklist.list_today,
            on_check_tick=self.checklist.tick,
            get_tooltip=lambda: self.messages.get(
                "tray_tooltip",
                mode=self.session_manager.mode,
                balance=self.wallet.get_balance(),
            ),
            tray_image_path=str(tray_image_path()) if tray_image_path().exists() else None,
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

    def _handle_quit_request(self) -> None:
        """托盘"退出"被点击 (从 pystray 线程触发)。

        通过 DialogBridge marshal 到 Qt 主线程渲染弹窗。
        """
        _log.info("收到退出请求 (托盘)")
        logo = str(dialog_image_path()) if dialog_image_path().exists() else None
        bridge = get_bridge()

        if not self.pin.has_pin():
            ok = bridge.ask_confirm(
                title=self.messages.get("quit_dialog_title"),
                message=self.messages.get("quit_confirm_no_pin"),
                logo_path=logo,
                confirm_text=self.messages.get("quit_button_confirm"),
                cancel_text=self.messages.get("quit_button_cancel"),
            )
            if ok:
                _log.info("无 PIN, 用户已确认退出")
                self._request_quit()
            else:
                _log.info("退出取消")
            return

        def _on_wrong(_max: int) -> str:
            remaining = max(0, self.pin._max_fails - self.pin._fails)  # noqa: SLF001
            return self.messages.get("quit_pin_wrong", remaining=remaining)

        def _on_locked(mins: int) -> str:
            return self.messages.get("quit_pin_locked", minutes=mins)

        ok = bridge.ask_pin(
            title=self.messages.get("quit_dialog_title"),
            prompt=self.messages.get("quit_prompt_pin"),
            logo_path=logo,
            verify=self.pin.verify,
            on_wrong=_on_wrong,
            on_locked=_on_locked,
            is_locked=self.pin.is_locked,
            seconds_until_unlock=self.pin.seconds_until_unlock,
            max_attempts=3,
            confirm_text=self.messages.get("quit_button_confirm"),
            cancel_text=self.messages.get("quit_button_cancel"),
        )
        if ok:
            _log.info("PIN 校验通过, 退出 Agent")
            self._request_quit()
        else:
            _log.info("PIN 校验未通过 / 用户取消, 继续运行")

    def _request_quit(self) -> None:
        """工作线程触发退出: 标记 stop + 通知 Qt 主线程结束 exec()。"""
        self._stop = True
        try:
            from PySide6.QtCore import QCoreApplication, QTimer
            app = QCoreApplication.instance()
            if app is not None:
                QTimer.singleShot(0, app.quit)
        except Exception:
            pass

    # ── 启动 / 主循环 ────────────────────────────────────────────
    def run(self, qt_app) -> None:
        """主线程跑 Qt 事件循环；扫描 / token / session / tray 都放后台线程。

        qt_app: 已经创建好的 QApplication 实例 (由 main() 持有)
        """
        _log.info("=" * 60)
        _log.info("NinoGame Agent 启动中; root=%s", self.root)
        _log.info("=" * 60)
        self._warn_missing_deps()

        # 日发放
        from datetime import date as _date
        base = self._today_base_grant()
        granted = self.wallet.ensure_daily_grant(base, _date.today())
        if granted:
            _log.info("今日基础发放: +%d token", granted)
        else:
            _log.info("今日基础发放已完成 (跳过)")
        _log.info("当前钱包余额: %d token", self.wallet.get_balance())

        _log.info("启动 activity_detector ...")
        self.activity.start()
        if self.activity.fallback_only:
            _log.info("  → fallback 模式 (鼠标抖动器无法识别)")

        _log.info("启动 session_manager (初始模式=%s) ...", self._initial_mode())
        self.session_manager.start(initial_mode=self._initial_mode())

        _log.info("启动 token_engine ...")
        self.token_engine.start()

        _log.info("启动 self_protector ...")
        self.self_protector.start()

        _log.info("启动 tray_icon ...")
        self.tray.start()
        from ui.tray_icon import HAS_TRAY
        if not HAS_TRAY:
            _log.info("  → tray 不可用 (依赖未装)，仅命令行模式")

        # 扫描循环：单独 worker 线程
        scan_interval = int(self.settings.get("monitor_scan_interval_seconds", 2))
        _log.info("-" * 60)
        _log.info("Agent 已就绪 | 规则数=%d | 扫描间隔=%ds | Ctrl+C 退出",
                  len(self.rules_repo.get_all()), scan_interval)
        _log.info("-" * 60)

        self._install_signal_handlers()
        import threading
        self._scan_thread = threading.Thread(
            target=self._scan_loop, args=(scan_interval,),
            name="scan-loop", daemon=True,
        )
        self._scan_thread.start()

        # 主线程: Qt 事件循环 (弹窗都在这里渲染)
        try:
            qt_app.exec()
        except KeyboardInterrupt:
            pass

        # exec 返回后清理
        self._stop = True
        try:
            self._scan_thread.join(timeout=3)
        except Exception:
            pass
        self._shutdown()

    def _scan_loop(self, scan_interval: int) -> None:
        last_heartbeat = time.monotonic()
        ticks_since_heartbeat = 0
        kills_since_heartbeat = 0
        heartbeat_period_seconds = 60

        while not self._stop:
            try:
                self.rules_repo.reload_if_changed()
                snaps = scan_processes()
                rules = self.rules_repo.get_all()
                matches = evaluate(snaps, rules)
                ticks_since_heartbeat += 1
                if matches:
                    handled = self.killer.handle(matches)
                    kills_since_heartbeat += handled
            except Exception:
                _log.exception("scan loop iteration failed")

            now_mono = time.monotonic()
            if now_mono - last_heartbeat >= heartbeat_period_seconds:
                _log.info(
                    "心跳 | mode=%s | balance=%d | 最近 %ds: 扫描 %d 次, 拦截 %d 个",
                    self.session_manager.mode,
                    self.wallet.get_balance(),
                    int(now_mono - last_heartbeat),
                    ticks_since_heartbeat,
                    kills_since_heartbeat,
                )
                last_heartbeat = now_mono
                ticks_since_heartbeat = 0
                kills_since_heartbeat = 0

            time.sleep(scan_interval)

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
            self._request_quit()

        try:
            signal.signal(signal.SIGINT, _handler)
            if sys.platform != "win32":
                signal.signal(signal.SIGTERM, _handler)
        except ValueError:
            pass

    def _warn_missing_deps(self) -> None:
        """启动时一次性提醒所有缺失的可选依赖与影响。"""
        from core.monitor import HAS_WIN32
        from ui.tray_icon import HAS_TRAY

        missing = []
        if not HAS_WIN32:
            missing.append(("pywin32", "窗口标题匹配 + 前台进程检测"))
        try:
            import pynput  # noqa: F401
        except ImportError:
            missing.append(("pynput", "严格活跃判定 (防鼠标抖动器)"))
        except Exception:
            missing.append(("pynput", "严格活跃判定 (导入异常)"))
        if not HAS_TRAY:
            missing.append(("pystray + Pillow", "系统托盘图标"))

        if not missing:
            _log.info("依赖检查: 全部齐备")
            return

        _log.warning("以下可选依赖缺失，相关功能将降级:")
        for pkg, what in missing:
            _log.warning("  - %s : %s", pkg, what)
        _log.warning("一键安装: pip install -r agent/requirements.txt")

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

    # Qt 必须在所有 widget 创建前在主线程上初始化
    from PySide6.QtWidgets import QApplication
    qt_app = QApplication.instance() or QApplication(sys.argv)
    qt_app.setQuitOnLastWindowClosed(False)  # 弹窗关了不退应用
    init_bridge()  # DialogBridge 注册到主线程

    Agent(root).run(qt_app)
    return 0


if __name__ == "__main__":
    sys.exit(main())
