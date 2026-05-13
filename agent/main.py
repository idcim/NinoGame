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
from comms.usage_reporter import UsageReporter  # noqa: E402
from core.activity_detector import ActivityDetector  # noqa: E402
from core.jiggler_detector import JigglerDetector  # noqa: E402
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
from ui.pair_dialog import PairDialog  # noqa: E402
from ui.request_dialog import RequestDialog  # noqa: E402
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
        self._bus_forwarders_wired = False  # _wire_transport 第一次接 bus, 后续 hot-swap 跳过
        self.usage_reporter: UsageReporter | None = None

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
        self.pair_dialog: PairDialog | None = None   # 按需 lazy 创建
        self.request_dialog: RequestDialog | None = None  # 同上
        # 临时解锁: rule_id -> 失效时刻 (utc datetime)
        # 家长 push temporary_unlock command 后填; rule_engine.evaluate
        # 会跳过这些规则; token_engine 仍按 consumption 扣费
        self._unlocked_until: dict[str, "datetime"] = {}

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
            on_show_pair=self._request_show_pair,
            on_show_request=self._request_show_request_dialog,
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

        # 日发放: 服务端是权威源。仅未配对 (离线模式) 时 Agent 本地发,
        # 保证孩子离线也能用 token; 配对后 hello_ack 时 server 端 ensureTodayGrant
        # 幂等补发, wallet_update 推回来同步本地。
        from datetime import date as _date
        if self._is_paired():
            _log.info("日发放: 已配对, 等服务端 ensureTodayGrant 接管")
        else:
            base = self._today_base_grant()
            granted = self.wallet.ensure_daily_grant(base, _date.today())
            if granted:
                _log.info("今日基础发放 (本地离线): +%d token", granted)
            else:
                _log.info("今日基础发放已完成 (跳过)")
        _log.info("当前钱包余额: %d token", self.wallet.get_balance())

        _log.info("启动 activity_detector ...")
        self.activity.start()

        # 鼠标抖动器检测 (§16.1 ②). 命中时 is_active_earning 返回 False,
        # 不让 productive 类应用刷 token; 同时 emit JIGGLER_ALERT 事件让
        # 家长浏览器实时看到。
        def _on_jiggler_alert(info: dict) -> None:
            _log.warning("★ 检测到鼠标抖动器嫌疑: %s", info)
            try:
                from comms.message_types import Event, EventType
                self.bus.publish(Event(
                    type=EventType.JIGGLER_ALERT.value,
                    payload=info,
                ))
            except Exception:
                _log.exception("发 JIGGLER_ALERT 事件失败")

        self.jiggler = JigglerDetector(
            sample_interval_seconds=1.0,
            window_size=60,
            box_threshold_px=80,
            alert_callback=_on_jiggler_alert,
            alert_cooldown_seconds=300,
        )
        self.activity.set_jiggler(self.jiggler)
        self.jiggler.start()
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

        _log.info("启动 usage_reporter (每 5 分钟上报 segments) ...")
        self.usage_reporter = UsageReporter(
            transport=self.transport,
            sessions=self.sessions_repo,
            child_id=str(self.settings.get("child_id", "")),
            device_id=str(self.settings.get("device_id", "")),
            interval_seconds=300,
        )
        self.usage_reporter.start()

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
            get_active_unlock=self._first_active_unlock_for_overlay,
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
            get_active_unlocks=self._active_unlock_info,
            daily_credit_cap=self._daily_credit_cap,
        )

        # 扫描循环：单独 worker 线程
        scan_interval = int(self.settings.get("monitor_scan_interval_seconds", 2))
        _log.info("-" * 60)
        _log.info("Agent 已就绪 | 规则数=%d | 扫描间隔=%ds | Ctrl+C 退出",
                  len(self.rules_repo.get_all()), scan_interval)
        _log.info("-" * 60)

        # 启动诊断: 列出规则 + 跑一次扫描看命中情况, 帮用户排查
        # "PvZ 还拦不住" 类问题
        self._startup_diagnostic()

        # 首次启动检测: settings 没 backend_url / agent_token → 自动弹配对框
        # (PySide6 widget 必须在 Qt 主线程; 用 QTimer 派发)
        if not self._is_paired():
            _log.info("未检测到 backend_url / agent_token, 准备弹出配对对话框")
            try:
                from PySide6.QtCore import QTimer
                QTimer.singleShot(1000, self._show_pair_dialog_on_main)
            except Exception:
                _log.exception("调度首次配对对话框失败")

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
                unlocked_ids = self._active_unlocked_ids()
                matches = evaluate(snaps, rules, unlocked_rule_ids=unlocked_ids)
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
        """启动 + 装订阅。
        分两块: 接到 transport 上的回调 (每次换 transport 都要重新装),
        接到 bus 上的转发器 (只装一次, 闭包用 self.transport 自动跟新)。
        """
        self._attach_transport_handlers()
        if not self._bus_forwarders_wired:
            self._wire_bus_forwarders()
            self._bus_forwarders_wired = True
        if hasattr(self.transport, "start"):
            try:
                self.transport.start()
            except Exception:
                _log.exception("transport.start 失败")

    def _attach_transport_handlers(self) -> None:
        """把 server→agent 的消息处理装到 self.transport 上 (每次换都要重装)。"""
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
            self._apply_server_rules(rules)
            if balance is not None:
                self._apply_server_wallet(balance)
            for cmd in pending:
                self._handle_command(cmd)

        def on_rules_update(msg):
            rules = (msg.get("payload") or {}).get("rules") or []
            _log.info("收到 rules_update: %d 条", len(rules))
            self._apply_server_rules(rules)

        def on_wallet_update(msg):
            balance = (msg.get("payload") or {}).get("balance")
            _log.info("收到 wallet_update: balance=%s", balance)
            if balance is not None:
                self._apply_server_wallet(balance)

        def on_command(msg):
            self._handle_command(msg.get("payload") or {})

        self.transport.subscribe("_connected", on_connected)
        self.transport.subscribe("hello_ack", on_hello_ack)
        self.transport.subscribe("rules_update", on_rules_update)
        self.transport.subscribe("wallet_update", on_wallet_update)
        self.transport.subscribe("command", on_command)

    def _wire_bus_forwarders(self) -> None:
        """bus 上的 BLOCK/TOKEN_DEDUCT 等事件 → 转发到当前 transport。
        闭包里 self.transport 是引用, 换 transport 后自动指向新对象, 无需重装。"""
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

    def _startup_diagnostic(self) -> None:
        """启动后跑一次诊断, 把"规则有哪些 + 当前能命中谁"打到日志,
        方便用户检查 PvZ 类拦截为什么没生效。"""
        try:
            rules = self.rules_repo.get_all()
            _log.info("【诊断】当前生效规则 %d 条:", len(rules))
            for r in rules:
                _log.info(
                    "  - id=%s name=%r enabled=%s matchers=%d action=%s",
                    r.id, r.name, r.enabled, len(r.matchers), r.action.type,
                )
            snaps, ms = scan_processes_timed()
            _log.info("【诊断】首轮扫描 %d 进程 / %.1f ms", len(snaps), ms)
            matches = evaluate(snaps, rules)
            if matches:
                _log.info("【诊断】当前已有 %d 个进程命中规则:", len(matches))
                for m in matches[:10]:
                    _log.info(
                        "  → pid=%d name=%r reason=%s",
                        m.process.pid, m.process.name, m.reason,
                    )
            else:
                _log.info(
                    "【诊断】当前无进程命中。如果 PvZ 在运行但没被拦, "
                    "用 tasklist 看真实进程名是否含 'pvz'/'plants'/'popcap', "
                    "如果都不含, 在 config/rules.json 的 matchers 加新关键词。"
                )
        except Exception:
            _log.exception("startup diagnostic 失败")

    def _apply_server_rules(self, server_rules: list[dict]) -> None:
        """server rules: [{id, name, enabled, spec}, ...]; spec 是 jsonb 包含
        matchers / matcher_logic / exclude_processes / schedule / action /
        category_link / notify_parent。展平后用 Rule.from_dict 解析,
        replace_all 覆盖本地 (写 rules.json + 通知 subscribers)。"""
        if not server_rules:
            _log.info("server 端无规则; 保留本地 rules.json")
            return
        try:
            from comms.message_types import Rule
            parsed: list[Rule] = []
            for row in server_rules:
                spec = row.get("spec") or {}
                if isinstance(spec, str):
                    import json as _json
                    try:
                        spec = _json.loads(spec)
                    except Exception:
                        spec = {}
                merged = {
                    "id": str(row.get("id")),
                    "name": row.get("name", ""),
                    "enabled": bool(row.get("enabled", True)),
                    **spec,
                }
                try:
                    parsed.append(Rule.from_dict(merged))
                except Exception:
                    _log.warning("server rule 解析失败, 跳过: id=%s", row.get("id"))
            self.rules_repo.replace_all(parsed)
            _log.info("server rules 已写入本地: %d 条", len(parsed))
        except Exception:
            _log.exception("应用 server rules 失败")

    def _handle_command(self, cmd: dict) -> None:
        """处理 server 推过来的 command 消息。

        支持类型 (CLAUDE.md §19.5):
          - temporary_unlock: payload {rule_id, duration_seconds | duration_minutes}
              → 在 self._unlocked_until 记录, rule_engine 跳过该规则
          - lock_device: 立即切换 Lock 模式
          - end_free_pass: (P3) 结束限免
          - request_status / request_photo: P3 + 实现
        """
        from datetime import datetime, timedelta
        ctype = cmd.get("command_type") or cmd.get("type") or ""
        payload = cmd.get("payload") or {}
        _log.info("处理 command: type=%s payload=%s", ctype, payload)

        if ctype == "temporary_unlock":
            rule_id = payload.get("rule_id")
            if not rule_id:
                _log.warning("temporary_unlock 缺 rule_id")
                return
            secs = int(payload.get("duration_seconds") or 0)
            mins = int(payload.get("duration_minutes") or 0)
            duration = secs if secs > 0 else mins * 60
            if duration <= 0:
                _log.warning("temporary_unlock 缺 duration")
                return
            expires_at = datetime.utcnow() + timedelta(seconds=duration)
            self._unlocked_until[rule_id] = expires_at
            _log.info(
                "★ 临时解锁: rule_id=%s 直到 %s (持续 %d 秒)",
                rule_id, expires_at.isoformat(timespec="seconds"), duration,
            )
            # 给孩子端弹通知 + 刷新浮层
            rule_name = self._rule_name(rule_id)
            self.notifier.info_async(
                self.messages.get(
                    "cmd_temporary_unlock_body",
                    rule_name=rule_name,
                    minutes=max(1, duration // 60),
                ),
                title=self.messages.get("cmd_temporary_unlock_title"),
            )
            return

        if ctype == "lock_device":
            self.session_manager.change_mode(
                SessionMode.LOCK.value, SessionEndReason.SWITCHED.value,
            )
            self.notifier.warn_async(
                self.messages.get("cmd_lock_device_body"),
                title=self.messages.get("cmd_lock_device_title"),
            )
            return

        if ctype == "start_free_pass":
            mins = int(payload.get("duration_minutes") or 0)
            _log.info("start_free_pass: %d 分钟", mins)
            self.notifier.info_async(
                self.messages.get("cmd_start_free_pass_body", minutes=mins),
                title=self.messages.get("cmd_start_free_pass_title"),
            )
            return

        if ctype == "end_free_pass":
            _log.info("end_free_pass")
            self.notifier.info_async(
                self.messages.get("cmd_end_free_pass_body"),
                title=self.messages.get("cmd_end_free_pass_title"),
            )
            return

        if ctype == "set_pin":
            # 家长在后台输 PIN, server 通过 WS 推过来
            # Agent 用 PinManager 加密保存到本地 settings.json
            pin = str(payload.get("pin", "")).strip()
            if not pin or len(pin) < 4:
                _log.warning("set_pin: PIN 无效 (空或 <4 位), 已拒绝")
                return
            try:
                self.pin.set_pin(pin)
                _log.info("★ PIN 已由家长远程设置 (长度=%d, 已加密)", len(pin))
                self.notifier.info_async(
                    "家长已远程设置新 PIN。下次退出 Agent 时会要求验证。",
                    title="NinoGame · PIN 已更新",
                )
            except Exception:
                _log.exception("set_pin 失败")
            return

        if ctype == "clear_pin":
            # 清空 PIN, 退出回退到普通确认对话框模式
            try:
                # PinManager 没有 clear_pin 方法; 直接清 settings.json 两个字段
                d = self.pin._read_settings()  # noqa: SLF001
                d["pin_hash"] = ""
                d["pin_salt"] = ""
                self.pin._write_settings(d)  # noqa: SLF001
                _log.info("★ PIN 已由家长远程清空")
                self.notifier.info_async(
                    "家长已远程清空 PIN。",
                    title="NinoGame · PIN 已清空",
                )
            except Exception:
                _log.exception("clear_pin 失败")
            return

        _log.warning("未知 command type: %s", ctype)

    def _rule_name(self, rule_id: str) -> str:
        """从本地 rules.json 找规则名给通知用; 找不到回退到 id。"""
        try:
            for r in self.rules_repo.get_all():
                if r.id == rule_id:
                    return r.name or rule_id
        except Exception:
            pass
        return rule_id

    def _active_unlocked_ids(self) -> set[str]:
        """rule_engine 用; 过滤掉已过期项 + 返回当前活跃的 unlock id 集合。
        过期时弹通知告诉孩子"时间到了"。"""
        if not self._unlocked_until:
            return set()
        from datetime import datetime
        now = datetime.utcnow()
        expired = [rid for rid, t in self._unlocked_until.items() if t <= now]
        for rid in expired:
            _log.info("临时解锁到期, 恢复拦截: rule_id=%s", rid)
            self._unlocked_until.pop(rid, None)
            try:
                self.notifier.warn_async(
                    self.messages.get("unlock_expired_body"),
                    title=self.messages.get("unlock_expired_title"),
                )
            except Exception:
                pass
        return set(self._unlocked_until.keys())

    def _first_active_unlock_for_overlay(self) -> tuple[str, int] | None:
        """Overlay 用: 返回最早到期的一个 (rule_name, seconds_remaining); 没有返回 None。"""
        unlocks = self._active_unlock_info()
        if not unlocks:
            return None
        unlocks.sort(key=lambda x: x[2])  # 最短剩余的优先
        _rid, name, secs = unlocks[0]
        return (name, secs)

    def _active_unlock_info(self) -> list[tuple[str, str, int]]:
        """供浮层 / 状态面板查询: 返回 [(rule_id, rule_name, seconds_remaining), ...]
        过期项不在内 (主循环调 _active_unlocked_ids 时会清掉)。"""
        if not self._unlocked_until:
            return []
        from datetime import datetime
        now = datetime.utcnow()
        out = []
        for rid, expires in list(self._unlocked_until.items()):
            secs = int((expires - now).total_seconds())
            if secs <= 0:
                continue
            out.append((rid, self._rule_name(rid), secs))
        return out

    def _apply_server_wallet(self, server_balance: int) -> None:
        try:
            delta = self.wallet.sync_balance(int(server_balance), reason="server_sync")
            if delta != 0:
                _log.info("钱包从 server 同步: delta=%+d, balance=%d",
                          delta, self.wallet.get_balance())
        except Exception:
            _log.exception("应用 server wallet 失败")

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

    def _request_show_pair(self) -> None:
        """tray 「重新配对家长后台」回调 (在 pystray 工作线程)。

        重新配对是敏感操作 (能改服务器), 流程:
          1) 如果设过 PIN: bridge.ask_pin 阻塞验证 (信号自动派发到 GUI 线程)
             用户取消 / 错 → 直接退
          2) bridge.show_pair_dialog 在 GUI 线程开 PairDialog (非阻塞)

        之前用 QTimer.singleShot 从 pystray 线程 schedule 槽, Qt 会偷偷
        把 timer 绑到 worker 线程上, 槽永远不跑 → 用户报"点了没反应".
        现在全部走 bridge 信号, GUI 线程槽接收, 行为靠谱。
        """
        # PIN 守门
        if self.pin.has_pin():
            _log.info("重新配对前先验证家长 PIN")
            try:
                from ui.assets import dialog_image_path
                logo = str(dialog_image_path()) if dialog_image_path().exists() else None
                ok = get_bridge().ask_pin(
                    title="家长验证",
                    prompt="重新配对会断开当前连接，请输入家长 PIN 继续。",
                    logo_path=logo,
                    verify=self.pin.verify,
                    on_wrong=lambda _max: self.messages.get(
                        "quit_pin_wrong",
                        remaining=max(0, self.pin._max_fails - self.pin._fails),  # noqa: SLF001
                    ),
                    on_locked=lambda mins: self.messages.get("quit_pin_locked", minutes=mins),
                    is_locked=self.pin.is_locked,
                    seconds_until_unlock=self.pin.seconds_until_unlock,
                    max_attempts=3,
                    confirm_text="继续",
                    cancel_text="取消",
                )
            except Exception:
                _log.exception("PIN 验证调用失败, 配对取消")
                return
            if not ok:
                _log.info("PIN 验证未通过 / 用户取消, 不开配对页")
                return
        else:
            _log.info("未设 PIN, 直接进配对页")

        # 通过 bridge 开 PairDialog (信号 → GUI 主线程槽)
        try:
            from ui.assets import dialog_image_path
            logo = str(dialog_image_path()) if dialog_image_path().exists() else None
            current_url = str(self.settings.get("backend_url", "")).strip()
            get_bridge().show_pair_dialog(
                settings_path=str(self.config_dir / "settings.json"),
                logo_path=logo,
                current_url=current_url,
                on_done=self._on_pair_done,
            )
        except Exception:
            _log.exception("show_pair_dialog 失败")

    def _request_show_request_dialog(self) -> None:
        """孩子在托盘点「申请游戏时间」→ 派发到 Qt 主线程开 RequestDialog。"""
        try:
            from PySide6.QtCore import QTimer
            QTimer.singleShot(0, self._show_request_dialog_on_main)
        except Exception:
            _log.exception("show request dialog 失败")

    def _show_request_dialog_on_main(self) -> None:
        try:
            from ui.assets import dialog_image_path
            if self.request_dialog is None:
                self.request_dialog = RequestDialog(
                    logo_path=str(dialog_image_path()) if dialog_image_path().exists() else None,
                    on_submit=self._submit_unlock_request,
                )
            self.request_dialog.show()
            self.request_dialog.raise_()
            self.request_dialog.activateWindow()
        except Exception:
            _log.exception("RequestDialog 显示失败")

    def _submit_unlock_request(self, text: str) -> bool:
        """RequestDialog 回调; 通过 transport 发 unlock_request 给 server。"""
        if not text.strip():
            return False
        if not self.transport.is_connected():
            _log.warning("transport 未连接, 申请发送失败")
            return False
        try:
            self.transport.send({
                "type": "unlock_request",
                "payload": {
                    "request_text": text,
                    "structured": {},
                },
            })
            _log.info("孩子已发起申请: %r", text[:60])
            return True
        except Exception:
            _log.exception("发送 unlock_request 失败")
            return False

    def _show_pair_dialog_on_main(self) -> None:
        """启动时未配对的"首次配对"路径。Qt 主线程上调用, 同样走 bridge
        信号 (统一通道, 跟 tray 重新配对走一样的代码)。
        首次配对不需要 PIN 守门 (此时设备还没绑定, 也没设 PIN)。"""
        try:
            from ui.assets import dialog_image_path
            logo = str(dialog_image_path()) if dialog_image_path().exists() else None
            current_url = str(self.settings.get("backend_url", "")).strip()
            get_bridge().show_pair_dialog(
                settings_path=str(self.config_dir / "settings.json"),
                logo_path=logo,
                current_url=current_url,
                on_done=self._on_pair_done,
            )
        except Exception:
            _log.exception("PairDialog 显示失败")

    def _is_paired(self) -> bool:
        url = str(self.settings.get("backend_url", "")).strip()
        token = str(self.settings.get("agent_token", "")).strip()
        return bool(url and token)

    def _on_pair_done(self, ok: bool, server_url: str, agent_token: str) -> None:
        """配对成功后热换 transport, 无需重启 Agent。"""
        if not ok:
            return
        _log.info("配对完成 (server=%s); 热换 transport ...", server_url)
        try:
            # 1) 重新读 settings.json (pair_dialog 已写入新值)
            settings_file = self.config_dir / "settings.json"
            try:
                import json as _json
                with open(settings_file, "r", encoding="utf-8") as f:
                    self.settings = _json.load(f)
            except Exception:
                _log.exception("重读 settings.json 失败, 沿用旧的")

            # 2) 停旧 transport (NullTransport.stop 是 no-op)
            try:
                if hasattr(self.transport, "stop"):
                    self.transport.stop()
            except Exception:
                _log.exception("旧 transport.stop 失败")

            # 3) 建新 transport (会按新 settings 选 WS or Null)
            self.transport = self._build_transport()

            # 4) 给新 transport 重接 handlers + start
            #    bus forwarders 闭包里读 self.transport, 不用重接
            self._attach_transport_handlers()
            if hasattr(self.transport, "start"):
                self.transport.start()

            # 5) usage_reporter 也指到新 transport + 新 child/device id
            if self.usage_reporter is not None:
                self.usage_reporter.update_transport(self.transport)
                self.usage_reporter.update_identity(
                    str(self.settings.get("child_id", "")),
                    str(self.settings.get("device_id", "")),
                )

            _log.info("transport 热换完成, WebSocketTransport 已启动")
            self.notifier.info_async(
                f"配对成功，已连接 {server_url}",
                title="NinoGame · 配对成功",
            )
        except Exception:
            _log.exception("热换 transport 失败; 请重启 Agent")
            try:
                self.notifier.warn_async(
                    "配对成功但热换连接失败，请关闭重开 Agent。",
                    title="NinoGame",
                )
            except Exception:
                pass

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
            if self.usage_reporter is not None:
                n = self.usage_reporter.flush_now()
                if n:
                    _log.info("shutdown flush: 推送 %d segments", n)
                self.usage_reporter.stop()
        except Exception:
            pass
        try:
            if hasattr(self.transport, "stop"):
                self.transport.stop()
        except Exception:
            pass
        try:
            if hasattr(self, "jiggler") and self.jiggler is not None:
                self.jiggler.stop()
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
