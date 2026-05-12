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
from comms.message_types import EventType, SessionEndReason, SessionMode  # noqa: E402
from comms.null_transport import NullTransport  # noqa: E402
from comms.transport import Transport  # noqa: E402
from core.activity_detector import ActivityDetector  # noqa: E402
from core.checklist import ResponsibilityChecklist  # noqa: E402
from core.classifier import Classifier  # noqa: E402
from core.killer import Killer  # noqa: E402
from core.messages import Messages  # noqa: E402
from core.monitor import get_foreground_process_snapshot, scan_processes, scan_processes_timed  # noqa: E402
from core.rule_engine import evaluate  # noqa: E402
from core.session_manager import SessionManager  # noqa: E402
from core.token_engine import TokenEngine, TokenEngineConfig  # noqa: E402
from protector.pin_manager import PinManager  # noqa: E402
from protector.self_protector import SelfProtector  # noqa: E402
from protector.single_instance import SingleInstanceLock  # noqa: E402
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
from ui.overlay import FloatingOverlay  # noqa: E402
from ui.panel import StatusPanel  # noqa: E402
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

        # 通信: settings 里有 backend_url + agent_token 就走 WS, 否则离线 Null
        self.bus = default_bus()
        self.transport = self._build_transport()

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
            strict_enabled=bool(self.settings.get("strict_input_detection_enabled", True)),
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

        # 浮层 (§15.3) —— Qt 主线程实例; QApplication 必须先建好
        # 这里只准备依赖, 真正 new FloatingOverlay 放到 run() 的主线程
        self._daily_credit_cap = int(overrides.get("daily_credit_cap", 120))
        self._daily_hard_cap_minutes = int(overrides.get("daily_hard_cap_minutes", 120))
        self._overlay_enabled = bool(self.settings.get("overlay_enabled", True))
        self.overlay: FloatingOverlay | None = None  # run() 创建
        self.panel: StatusPanel | None = None        # run() 创建

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
            is_overlay_enabled=lambda: self._overlay_enabled,
            toggle_overlay=self._toggle_overlay,
            on_show_panel=self._request_show_panel,
        )

        self._stop = False

    def _build_transport(self) -> Transport:
        url = self.settings.get("backend_url", "").strip()
        token = self.settings.get("agent_token", "").strip()
        if not url or not token:
            _log.info("backend_url / agent_token 未配置, 使用 NullTransport (离线模式)")
            return NullTransport()
        # http://x:y → ws://x:y/ws/agent; https → wss
        if url.startswith("https://"):
            ws_url = "wss://" + url[len("https://"):].rstrip("/") + "/ws/agent"
        elif url.startswith("http://"):
            ws_url = "ws://" + url[len("http://"):].rstrip("/") + "/ws/agent"
        else:
            ws_url = url.rstrip("/") + "/ws/agent"
        from comms.websocket_transport import WebSocketTransport
        _log.info("使用 WebSocketTransport: %s", ws_url)
        return WebSocketTransport(url=ws_url, agent_token=token)

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
        """工作线程触发退出: 标记 stop + 通知 Qt 主线程结束 exec()。

        必须用 QMetaObject.invokeMethod + QueuedConnection 跨线程；
        QTimer.singleShot 只能在 Qt 线程里调用 (否则会打:
        "QObject::startTimer: Timers can only be used with threads
         started with QThread")。
        """
        self._stop = True
        try:
            from PySide6.QtCore import QCoreApplication, QMetaObject, Qt
            app = QCoreApplication.instance()
            if app is not None:
                QMetaObject.invokeMethod(app, "quit", Qt.QueuedConnection)
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

        _log.info("启动 transport ...")
        self._wire_transport()

        _log.info("启动 tray_icon ...")
        self.tray.start()
        from ui.tray_icon import HAS_TRAY
        if not HAS_TRAY:
            _log.info("  → tray 不可用 (依赖未装)，仅命令行模式")

        # 浮层 (§15.3): 在 Qt 主线程上创建
        _log.info("启动 overlay (默认%s) ...", "开" if self._overlay_enabled else "关")
        self.overlay = FloatingOverlay(
            get_balance=self.wallet.get_balance,
            get_mode=lambda: self.session_manager.mode,
            get_foreground_info=self._foreground_info,
            get_remaining_cap_minutes=self._remaining_cap_minutes,
            is_active=self.activity.is_active_consumption,
            daily_credit_cap=self._daily_credit_cap,
        )
        self.overlay.set_enabled(self._overlay_enabled)

        # 状态面板 (托盘双击触发)
        _log.info("启动 status panel ...")
        self.panel = StatusPanel(
            logo_path=str(dialog_image_path()) if dialog_image_path().exists() else None,
            get_balance=self.wallet.get_balance,
            get_mode=lambda: self.session_manager.mode,
            get_daily_consumed=self.wallet.get_daily_consumed,
            get_daily_credited=self.wallet.get_daily_credited,
            get_today_consumption_minutes=lambda: self.sessions_repo.today_consumption_seconds() // 60,
            get_checklist_progress=self._checklist_progress,
            on_lock=lambda: self.session_manager.change_mode(
                SessionMode.LOCK.value, SessionEndReason.MANUAL_LOCK.value
            ),
            on_resume=lambda: self.session_manager.change_mode(
                SessionMode.CHILD.value, SessionEndReason.SWITCHED.value
            ),
            daily_credit_cap=self._daily_credit_cap,
        )

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
        ms_sum = 0.0
        ms_max = 0.0
        heartbeat_period_seconds = 60

        while not self._stop:
            try:
                self.rules_repo.reload_if_changed()
                snaps, scan_ms = scan_processes_timed()
                rules = self.rules_repo.get_all()
                matches = evaluate(snaps, rules)
                ticks_since_heartbeat += 1
                ms_sum += scan_ms
                if scan_ms > ms_max:
                    ms_max = scan_ms
                if matches:
                    handled = self.killer.handle(matches)
                    kills_since_heartbeat += handled
            except Exception:
                _log.exception("scan loop iteration failed")

            now_mono = time.monotonic()
            if now_mono - last_heartbeat >= heartbeat_period_seconds:
                avg_ms = ms_sum / max(1, ticks_since_heartbeat)
                _log.info(
                    "心跳 | mode=%s | balance=%d | %ds: scan %d 次, "
                    "avg %.1f ms / max %.1f ms | 拦截 %d 个",
                    self.session_manager.mode,
                    self.wallet.get_balance(),
                    int(now_mono - last_heartbeat),
                    ticks_since_heartbeat,
                    avg_ms,
                    ms_max,
                    kills_since_heartbeat,
                )
                last_heartbeat = now_mono
                ticks_since_heartbeat = 0
                kills_since_heartbeat = 0
                ms_sum = 0.0
                ms_max = 0.0

            time.sleep(scan_interval)

    def _today_base_grant(self) -> int:
        from datetime import date as _date
        overrides = self.settings.get("quota_overrides", {})
        is_weekend = _date.today().weekday() >= 5
        if is_weekend:
            return int(overrides.get("weekend_base_tokens", 90))
        return int(overrides.get("weekday_base_tokens", 30))

    def _wire_transport(self) -> None:
        """Transport 启动 + 装 server→agent 消息处理 + 装 bus→server 上报。"""
        # 没接服务端 (NullTransport) 时, subscribe 是 no-op, 启动 no-op, 也无害
        if hasattr(self.transport, "start"):
            try:
                self.transport.start()
            except Exception:
                _log.exception("transport.start 失败")

        # 连接成功后 fire hello
        def on_connected(_msg):
            _log.info("WS 已连; 发 hello")
            self.transport.send({
                "type": "hello",
                "payload": {
                    "agent_version": "0.1.0",
                    "device_info": {"platform": "windows"},
                },
            })

        def on_hello_ack(msg):
            payload = msg.get("payload", {}) or {}
            rules = payload.get("rules") or []
            balance = payload.get("wallet_balance", None)
            pending = payload.get("pending_commands") or []
            _log.info(
                "收到 hello_ack: server rules=%d, wallet=%s, pending_cmds=%d",
                len(rules), balance, len(pending),
            )
            # P2 + : 把 server rules 合并 / 覆盖到本地 RuleRepository
            # 现在保守: 仅日志, 待规则 schema 对齐再写入

        def on_rules_update(msg):
            rules = (msg.get("payload") or {}).get("rules") or []
            _log.info("收到 rules_update: %d 条 (P2 待落地: 写本地)", len(rules))

        def on_wallet_update(msg):
            balance = (msg.get("payload") or {}).get("balance")
            _log.info("收到 wallet_update: balance=%s (P2 待落地: 更新本地缓存)", balance)

        def on_command(msg):
            cmd = msg.get("payload") or {}
            _log.info("收到 command: %s (P3 待执行)", cmd.get("command_type"))

        self.transport.subscribe("_connected", on_connected)
        self.transport.subscribe("hello_ack", on_hello_ack)
        self.transport.subscribe("rules_update", on_rules_update)
        self.transport.subscribe("wallet_update", on_wallet_update)
        self.transport.subscribe("command", on_command)

        # bus 上的 BLOCK / TOKEN_DEDUCT / TOKEN_CREDIT / 等事件 → 上报后端 events
        def forward_event_to_server(event):
            if not self.transport.is_connected():
                return
            try:
                self.transport.send({
                    "type": "event",
                    "payload": {
                        "event_type": event.type,
                        "payload": event.payload,
                    },
                })
            except Exception:
                _log.exception("event 转发失败")

        # 关心几类需要上报的事件
        for evt in (
            EventType.BLOCK,
            EventType.SESSION_OPEN,
            EventType.SESSION_CLOSE,
            EventType.TOKEN_DEDUCT,
            EventType.TOKEN_CREDIT,
            EventType.JIGGLER_ALERT,
            EventType.PIN_FAIL,
            EventType.UNKNOWN_APP,
        ):
            self.bus.subscribe(evt.value, forward_event_to_server)

    def _checklist_progress(self) -> tuple[int, int]:
        try:
            items = self.checklist.list_today()
            done = sum(1 for _, ok in items if ok)
            return (done, len(items))
        except Exception:
            return (0, 0)

    def _request_show_panel(self) -> None:
        """tray 单击/双击 → 跨线程触发 panel 显示。"""
        if self.panel is None:
            return
        try:
            from PySide6.QtCore import QMetaObject, Qt
            QMetaObject.invokeMethod(self.panel, "show_panel", Qt.QueuedConnection)
        except Exception:
            _log.exception("show panel 失败")

    def _toggle_overlay(self) -> None:
        """tray 菜单切换浮层开关。注意 tray 在 pystray 线程,
        而 overlay 是 QWidget; 通过 invokeMethod 派发到主线程。"""
        new_state = not self._overlay_enabled
        self._overlay_enabled = new_state
        _log.info("浮层切换: %s", "开" if new_state else "关")
        if self.overlay is None:
            return
        try:
            from PySide6.QtCore import QMetaObject, Qt, Q_ARG
            QMetaObject.invokeMethod(
                self.overlay, "set_enabled", Qt.QueuedConnection,
                Q_ARG(bool, new_state),
            )
        except Exception:
            _log.exception("toggle overlay 失败")

    def _foreground_info(self) -> tuple[str, float] | None:
        """返回 (category, rate_multiplier); 拿不到前台或异常返回 None。
        浮层用它判断显示模式 (消费中 / 学习中 / 中性)。"""
        try:
            snap = get_foreground_process_snapshot()
            if snap is None:
                return None
            cat = self.classifier.classify(snap)
            return (cat.category, float(cat.rate_multiplier or 1.0))
        except Exception:
            _log.exception("foreground info query failed")
            return None

    def _remaining_cap_minutes(self) -> int:
        """今日剩余可玩分钟数 (考虑 daily_hard_cap_minutes)。"""
        try:
            used = self.sessions_repo.today_consumption_seconds()
            return max(0, self._daily_hard_cap_minutes - used // 60)
        except Exception:
            return self._daily_hard_cap_minutes

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
            if hasattr(self.transport, "stop"):
                self.transport.stop()
        except Exception:
            pass
        try:
            if self.panel is not None:
                self.panel.hide()
                self.panel.deleteLater()
        except Exception:
            pass
        try:
            if self.overlay is not None:
                self.overlay.hide()
                self.overlay.deleteLater()
        except Exception:
            pass
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


_INSTANCE_LOCK_NAME = "Local\\NinoGameAgent_SingleInstance_v1"


def main() -> int:
    # 先抢单实例锁 (Windows 命名 mutex). 第二次双击立即退出, 不进入 Qt
    instance_lock = SingleInstanceLock(_INSTANCE_LOCK_NAME)
    if not instance_lock.acquire():
        # 此时 logging 还没建好, print 兜底
        print(
            "[NinoGame] 已有一个 Agent 实例在运行, 本次启动退出。\n"
            "           如果托盘里看不到, 用任务管理器结束 NinoGameAgent.exe 再试。",
            flush=True,
        )
        return 0

    root = _resolve_root()

    # Qt 必须在所有 widget 创建前在主线程上初始化
    from PySide6.QtWidgets import QApplication
    qt_app = QApplication.instance() or QApplication(sys.argv)
    qt_app.setQuitOnLastWindowClosed(False)  # 弹窗关了不退应用
    init_bridge()  # DialogBridge 注册到主线程

    try:
        Agent(root).run(qt_app)
    finally:
        instance_lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
