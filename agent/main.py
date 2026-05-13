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
    SqliteNotificationRepository,
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
from ui.history_window import (  # noqa: E402
    HistoryWindow,
    render_ledger_row,
    render_notification_row,
)
from ui.out_of_token_dialog import OutOfTokenDialog  # noqa: E402
from ui.task_claim_dialog import TaskClaimDialog  # noqa: E402
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

        # 决策 #35: 老 settings.json 还在用 daily_hard_cap_minutes=120,
        # 一次性迁移到 0 (= 不限)。家长想保留硬上限可后续主动设非 0。
        if int(overrides.get("daily_hard_cap_minutes", 0)) == 120 \
                and not self.settings.get("_migrated_hard_cap_v2"):
            overrides["daily_hard_cap_minutes"] = 0
            self.settings["quota_overrides"] = overrides
            self.settings["_migrated_hard_cap_v2"] = True
            try:
                with open(self.config_dir / "settings.json", "w", encoding="utf-8") as f:
                    json.dump(self.settings, f, ensure_ascii=False, indent=2)
                _log.warning(
                    "★ 决策 #35: 把 daily_hard_cap_minutes 从 120 迁到 0 (= 不限)。"
                    " 如果你想保留 2 小时硬上限, 改回 120 (settings.json)"
                )
            except Exception:
                _log.exception("写迁移后的 settings.json 失败")

        # 数据
        self.db = open_db(self.data_dir / "ninogame.db")
        self.rules_repo = JsonRuleRepository(self.config_dir / "rules.json")
        self.app_categories = SqliteAppCategoryRepository(self.db)
        self.wallet = SqliteWalletService(self.db)
        self.events = SqliteEventSink(self.db)
        self.sessions_repo = SqliteSessionRepository(self.db)
        self.unknown_queue = SqliteUnknownAppQueue(self.db)
        self.resp_repo = SqliteResponsibilityRepository(self.db)
        self.notif_repo = SqliteNotificationRepository(self.db)
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
            record_history=self.notif_repo.record,
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
            is_free_pass_active=self._is_free_pass_active,
            send_token_tick=self._send_token_tick,
            on_out_of_token=self._on_out_of_token,
            on_token_replenished=self._on_token_replenished,
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
        self.task_claim_dialog: TaskClaimDialog | None = None  # 同上
        self.messages_window: HistoryWindow | None = None  # 我的消息
        self.ledger_window: HistoryWindow | None = None    # 余额变动
        self.out_of_token_dialog: OutOfTokenDialog | None = None  # 余额耗尽锁屏
        # 临时解锁: rule_id -> 失效时刻 (utc datetime)
        # 家长 push temporary_unlock command 后填; rule_engine.evaluate
        # 会跳过这些规则; token_engine 仍按 consumption 扣费
        self._unlocked_until: dict[str, "datetime"] = {}
        # 限免活动 (§14.4): 全局期内 consumption 不扣 token, 但仍计 active_seconds。
        # 由 server push start_free_pass / end_free_pass 维护, 重连 hello_ack 携带活跃段。
        self._free_pass_until: "datetime | None" = None

        # 托盘 (孩子主动 lock/resume 入口已移除, 详见 panel.py / tray_icon.py)
        self.tray = TrayController(
            get_balance=self.wallet.get_balance,
            get_mode=lambda: self.session_manager.mode,
            get_daily_credit_cap=lambda: int(overrides.get("daily_credit_cap", 120)),
            on_quit_request=self._handle_quit_request,
            get_checklist=self.checklist.list_today,
            on_check_tick=self.checklist.tick,
            get_tooltip=self._build_tray_tooltip,
            tray_image_path=str(tray_image_path()) if tray_image_path().exists() else None,
            is_overlay_enabled=lambda: self._overlay_enabled,
            toggle_overlay=self._toggle_overlay,
            on_show_panel=self._request_show_panel,
            on_show_pair=self._request_show_pair,
            on_show_request=self._request_show_request_dialog,
            on_show_task_claim=self._request_show_task_claim_dialog,
            on_show_messages=self._request_show_messages_window,
            on_show_ledger=self._request_show_ledger_window,
            on_switch_to_child=self._switch_back_to_child,
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

        同时写 data/agent_quit.flag 通知 Watchdog "主动退出, 不要重启";
        Watchdog 主循环看到此 flag 会自己也退出。Agent crash 时不会写,
        Watchdog 仍按正常 stale 检测重启。
        """
        self._stop = True
        try:
            flag = self.data_dir / "agent_quit.flag"
            flag.parent.mkdir(parents=True, exist_ok=True)
            with open(flag, "w", encoding="utf-8") as f:
                f.write(f"{os.getpid()}\n{int(time.time())}\n")
            _log.info("已写 agent_quit.flag, Watchdog 看到后将一并退出")
        except Exception:
            _log.exception("写 agent_quit.flag 失败")
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

        # 清掉上次"主动退出"标记 (这次启动是正常 boot, 不要让 Watchdog
        # 误以为还在退出态而立即自杀)。Watchdog 主循环每 5s 看一次, 即便
        # 旧 flag 残留只要 Agent 已经写 alive 文件就不会被重启。
        try:
            stale_flag = self.data_dir / "agent_quit.flag"
            if stale_flag.exists():
                stale_flag.unlink()
                _log.info("清掉残留的 agent_quit.flag")
        except Exception:
            _log.exception("清 agent_quit.flag 失败")

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

        # LLM 应用分类 (§9.3 / §12.3): 每 5 分钟把本地 unknown_apps_queue 推 server
        _log.info("启动 unknown_apps_reporter (每 5 分钟推未分类 app 给 server LLM) ...")
        self._start_unknown_apps_reporter(interval_seconds=300)

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
            tasks = payload.get("tasks") or []
            balance = payload.get("wallet_balance", None)
            pending = payload.get("pending_commands") or []
            active_fp = payload.get("active_free_pass")
            _log.info(
                "收到 hello_ack: server rules=%d, tasks=%d, wallet=%s, pending_cmds=%d, free_pass=%s",
                len(rules), len(tasks), balance, len(pending),
                "yes" if active_fp else "no",
            )
            self._apply_server_rules(rules)
            self._apply_server_tasks(tasks)
            if balance is not None:
                # hello_ack 是重连后 server 给的权威值 (含每日发放等), 无条件应用
                self._apply_server_wallet(balance, reason="hello_sync")
            self._apply_active_free_pass(active_fp)
            for cmd in pending:
                self._handle_command(cmd)

        def on_rules_update(msg):
            rules = (msg.get("payload") or {}).get("rules") or []
            _log.info("收到 rules_update: %d 条", len(rules))
            self._apply_server_rules(rules)

        def on_app_categories_update(msg):
            """server LLM 分类回来的 app_categories 写本地 cache + 标 processed."""
            payload = msg.get("payload") or {}
            updates = payload.get("updates") or []
            if not isinstance(updates, list) or not updates:
                return
            from comms.message_types import AppCategory as AC
            written: list[str] = []
            for u in updates:
                if not isinstance(u, dict):
                    continue
                aid = str(u.get("app_identifier") or "").strip().lower()
                if not aid:
                    continue
                try:
                    self.app_categories.upsert(AC(
                        app_identifier=aid,
                        category=str(u.get("category") or "neutral"),
                        sub_type=str(u.get("sub_type") or ""),
                        rate_multiplier=float(u.get("rate_multiplier") or 1.0),
                        source="llm",
                    ))
                    written.append(aid)
                except Exception:
                    _log.exception("写 app_categories 失败 aid=%s", aid)
            if written:
                try:
                    self.unknown_queue.mark_processed(written)
                except Exception:
                    _log.exception("标记 unknown_apps processed 失败")
                _log.info(
                    "收到 app_categories_update: 写入 %d 条 (server LLM 分类)", len(written),
                )

        def on_tasks_update(msg):
            tasks = (msg.get("payload") or {}).get("tasks") or []
            _log.info("收到 tasks_update: %d 条", len(tasks))
            self._apply_server_tasks(tasks)

        def on_wallet_update(msg):
            payload = msg.get("payload") or {}
            balance = payload.get("balance")
            reason = str(payload.get("reason") or "")
            delta = payload.get("delta")
            comment = str(payload.get("comment") or "")
            _log.info(
                "收到 wallet_update: balance=%s reason=%s delta=%s",
                balance, reason, delta,
            )
            if balance is not None:
                # 透传 reason: server_sync (scheduler 定期推) 时 sync_balance 内部
                # 会跳过 delta>0 的情况 (防 stale-read 回滚); 其它 reason 正常应用
                self._apply_server_wallet(balance, reason=reason or "server_sync")

            # 静默 reason: 每分钟的 app_consumption / server 主动同步 — 不弹 / 不入历史
            SILENT_REASONS = {"app_consumption", "server_sync"}
            if reason in SILENT_REASONS:
                return

            # 家长可见操作: 弹通知 + 写本地 ledger cache + 写 notification 历史
            try:
                if not isinstance(delta, (int, float)) or int(delta) == 0:
                    return
                n = int(delta)
                amount_str = f"+{n}" if n > 0 else str(n)
                tail = f" ({comment})" if comment else ""
                title = "NinoGame · 余额变动"
                body = f"余额变动 {amount_str} token{tail}"
                if reason == "task_reward":
                    title = "NinoGame · 任务奖励"
                    body = f"家长批准了你的任务{tail}, {amount_str} token 已到账。" if n > 0 \
                        else f"任务奖励调整{tail}: {amount_str} token。"
                elif reason == "parent_grant":
                    title = "NinoGame · 家长发奖" if n > 0 else "NinoGame · 家长扣分"
                    body = f"家长给你发了 {amount_str} token{tail}。" if n > 0 \
                        else f"家长扣了 {abs(n)} token{tail}。"
                elif reason == "adjustment":
                    title = "NinoGame · 余额调整"
                    body = f"家长调整了余额: {amount_str} token{tail}。"
                elif reason == "daily_grant":
                    title = "NinoGame · 每日发放"
                    body = f"今日基础发放 {amount_str} token 已到账。"
                elif reason == "refund":
                    title = "NinoGame · 退款"
                    body = f"退回 {amount_str} token{tail}。"
                # 其它未识别 reason 用默认 title/body

                # notifier 内部会把这条写进 notification_history
                self.notifier.info_async(body, title=title)

                # 写本地 token_ledger cache, 给 "余额变动" 窗口数据源
                try:
                    if balance is not None:
                        self.wallet.record_external_ledger(n, int(balance), reason, comment)
                except Exception:
                    _log.exception("写本地 ledger cache 失败")
            except Exception:
                _log.exception("wallet_update 处理失败")

        def on_command(msg):
            self._handle_command(msg.get("payload") or {})

        self.transport.subscribe("_connected", on_connected)
        self.transport.subscribe("hello_ack", on_hello_ack)
        self.transport.subscribe("rules_update", on_rules_update)
        self.transport.subscribe("tasks_update", on_tasks_update)
        self.transport.subscribe("app_categories_update", on_app_categories_update)
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
            EventType.CHECKLIST_TICK,
            EventType.STATUS,
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

    def _apply_server_tasks(self, server_tasks: list[dict]) -> None:
        """server tasks: [{id, child_id, name, category, reward_tokens, ...}, ...]
        覆写本地 config/tasks.json + 重载 checklist (responsibility 类立刻刷新)。

        激励类 (incentive) 现在仅写入本地 (P2 留给 P3 在托盘加"申报完成"按钮);
        责任类 (responsibility) 立刻通过 checklist 展示在 tray 菜单。
        """
        if not server_tasks:
            _log.info("server 端无任务模板; 保留本地 tasks.json")
            return
        try:
            normalized = []
            for t in server_tasks:
                normalized.append({
                    "id": str(t.get("id", "")),
                    "name": str(t.get("name", "")),
                    "category": str(t.get("category", "incentive")),
                    "reward_tokens": int(t.get("reward_tokens", 0) or 0),
                    "schedule": str(t.get("schedule", "daily")),
                    "verification": str(t.get("verification", "parent_approve")),
                    "daily_max_completions": int(t.get("daily_max_completions", 1) or 1),
                    "active": bool(t.get("active", True)),
                })
            tasks_path = self.config_dir / "tasks.json"
            tasks_path.parent.mkdir(parents=True, exist_ok=True)
            with open(tasks_path, "w", encoding="utf-8") as f:
                json.dump(normalized, f, ensure_ascii=False, indent=2)
            self.checklist.reload()
            resp_count = sum(1 for t in normalized if t["category"] == "responsibility")
            inc_count = sum(1 for t in normalized if t["category"] == "incentive")
            _log.info(
                "server tasks 已写入本地: %d 条 (责任=%d, 激励=%d)",
                len(normalized), resp_count, inc_count,
            )
        except Exception:
            _log.exception("应用 server tasks 失败")

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
          - request_status: P3 + 实现 (拍照机制已下线, 改私下协商 + 家长后台 +token)
        """
        from datetime import datetime, timedelta
        ctype = cmd.get("command_type") or cmd.get("type") or ""
        payload = cmd.get("payload") or {}
        _log.info("处理 command: type=%s payload=%s", ctype, payload)

        if ctype == "temporary_unlock":
            # 新: 优先 rule_ids (数组, server normalize 后的形态); 兼容老 rule_id (单数)
            rule_ids_raw = payload.get("rule_ids")
            if isinstance(rule_ids_raw, list) and rule_ids_raw:
                rule_ids = [str(x) for x in rule_ids_raw if x]
            elif payload.get("rule_id"):
                rule_ids = [str(payload.get("rule_id"))]
            else:
                _log.warning("temporary_unlock 缺 rule_ids/rule_id")
                return
            secs = int(payload.get("duration_seconds") or 0)
            mins = int(payload.get("duration_minutes") or 0)
            duration = secs if secs > 0 else mins * 60
            if duration <= 0:
                _log.warning("temporary_unlock 缺 duration")
                return
            expires_at = datetime.utcnow() + timedelta(seconds=duration)
            for rid in rule_ids:
                self._unlocked_until[rid] = expires_at
            _log.info(
                "★ 临时解锁 %d 条规则: %s 直到 %s (持续 %d 秒)",
                len(rule_ids), rule_ids, expires_at.isoformat(timespec="seconds"), duration,
            )
            # 给孩子端弹一个合并通知 (多规则只弹一次)
            if len(rule_ids) == 1:
                display_name = self._rule_name(rule_ids[0])
            else:
                display_name = f"{len(rule_ids)} 条规则"
            self.notifier.info_async(
                self.messages.get(
                    "cmd_temporary_unlock_body",
                    rule_name=display_name,
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
            if mins <= 0:
                _log.warning("start_free_pass 缺 duration_minutes")
                return
            self._free_pass_until = datetime.utcnow() + timedelta(minutes=mins)
            _log.info(
                "★ 启动限免活动: %d 分钟, 期间 consumption 不扣 token (直到 %s)",
                mins, self._free_pass_until.isoformat(timespec="seconds"),
            )
            self.notifier.info_async(
                self.messages.get("cmd_start_free_pass_body", minutes=mins),
                title=self.messages.get("cmd_start_free_pass_title"),
            )
            return

        if ctype == "end_free_pass":
            was_active = self._free_pass_until is not None
            self._free_pass_until = None
            _log.info("★ 终止限免活动 (manual end, was_active=%s)", was_active)
            if was_active:
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

    def _build_tray_tooltip(self) -> str:
        base = self.messages.get(
            "tray_tooltip",
            mode=self.session_manager.mode,
            balance=self.wallet.get_balance(),
        )
        secs = self._free_pass_remaining_seconds()
        if secs > 0:
            mins = (secs + 59) // 60
            return f"{base}\n限免中 · 剩 {mins} 分"
        return base

    # ── 限免活动 (§14.4) ─────────────────────────────────────
    def _is_free_pass_active(self) -> bool:
        """token_engine 用: True 时跳过 consumption 扣分。
        过期项就地清掉, 同时弹"限免结束"通知。"""
        if self._free_pass_until is None:
            return False
        from datetime import datetime
        now = datetime.utcnow()
        if now >= self._free_pass_until:
            _log.info("★ 限免到期, 恢复正常计费")
            self._free_pass_until = None
            try:
                self.notifier.info_async(
                    self.messages.get("cmd_end_free_pass_body"),
                    title=self.messages.get("cmd_end_free_pass_title"),
                )
            except Exception:
                pass
            return False
        return True

    def _free_pass_remaining_seconds(self) -> int:
        """供 tray / overlay / panel 查询; 不主动清过期 (那个由 token tick 触发)。"""
        if self._free_pass_until is None:
            return 0
        from datetime import datetime
        secs = int((self._free_pass_until - datetime.utcnow()).total_seconds())
        return max(0, secs)

    def _apply_active_free_pass(self, info: dict | None) -> None:
        """hello_ack 把 server 上未结束的限免段塞回来, 让 Agent 重启后继续生效。"""
        if not info or not isinstance(info, dict):
            return
        try:
            from datetime import datetime, timedelta
            remaining = int(info.get("remaining_seconds") or 0)
            if remaining <= 0:
                return
            self._free_pass_until = datetime.utcnow() + timedelta(seconds=remaining)
            _log.info(
                "★ hello_ack 恢复限免态: free_pass_id=%s, 剩余 %d 秒",
                info.get("id"), remaining,
            )
        except Exception:
            _log.exception("应用 active_free_pass 失败")

    def _apply_server_wallet(self, server_balance: int, reason: str = "server_sync") -> None:
        try:
            delta = self.wallet.sync_balance(int(server_balance), reason=reason)
            if delta != 0:
                _log.info("钱包从 server 同步: delta=%+d, balance=%d (reason=%s)",
                          delta, self.wallet.get_balance(), reason)
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
        """孩子在托盘点「申请游戏时间」→ bridge 派发到 Qt 主线程。

        注意: 不能用 QTimer.singleShot(0, ...) 从 pystray worker 线程调度!
        Qt 会把 timer 绑到 worker 线程, 槽永远不跑 → "点了没反应"。
        必须走 get_bridge().run_on_gui (信号通道, 自动 marshal 到 GUI 线程).
        """
        get_bridge().run_on_gui(self._show_request_dialog_on_main)

    def _show_request_dialog_on_main(self) -> None:
        try:
            from ui.assets import dialog_image_path
            if self.request_dialog is None:
                self.request_dialog = RequestDialog(
                    logo_path=str(dialog_image_path()) if dialog_image_path().exists() else None,
                    on_submit=self._submit_unlock_request,
                    get_transport_warning=self._transport_warning,
                )
            self.request_dialog.show()
            self.request_dialog.raise_()
            self.request_dialog.activateWindow()
        except Exception:
            _log.exception("RequestDialog 显示失败")

    def _start_unknown_apps_reporter(self, interval_seconds: int = 300) -> None:
        """轻量周期任务: 每 N 秒拉 unknown_apps_queue.list_pending → WS 推 server.
        server 端 LLM 分类完会推回 app_categories_update; 落本地由 on_app_categories_update
        + mark_processed 完成。
        """
        import threading

        def _loop():
            stop = self._unknown_apps_stop
            while not stop.is_set():
                stop.wait(interval_seconds)
                if stop.is_set():
                    return
                try:
                    if not self.transport.is_connected():
                        continue
                    rows = self.unknown_queue.list_pending(50)
                    if not rows:
                        continue
                    apps = [
                        {
                            "app_identifier": r["app_identifier"],
                            "exe_path": r.get("exe_path") or "",
                            "window_title": r.get("window_title") or "",
                        }
                        for r in rows
                    ]
                    self.transport.send({
                        "type": "unknown_apps",
                        "payload": {"apps": apps},
                    })
                    _log.info("推 unknown_apps 给 server LLM 分类: %d 个", len(apps))
                except Exception:
                    _log.exception("unknown_apps_reporter tick failed")

        import threading as _t
        self._unknown_apps_stop = _t.Event()
        self._unknown_apps_thread = _t.Thread(
            target=_loop, name="unknown-apps-reporter", daemon=True,
        )
        self._unknown_apps_thread.start()

    # ── 余额耗尽全屏锁屏 (网吧模式) ─────────────────────────
    def _on_out_of_token(self) -> None:
        """token_engine 检测到余额耗尽时触发. 工作线程调; bridge 派发到 GUI 线程."""
        _log.info("★ 余额耗尽, 触发锁屏 + 切 Lock 模式")
        # 立即切 Lock 模式 (停 child session)
        try:
            self.session_manager.change_mode(
                SessionMode.LOCK.value, SessionEndReason.SWITCHED.value,
            )
        except Exception:
            _log.exception("切 Lock 失败")
        # 弹全屏锁屏对话框 (GUI 线程)
        get_bridge().run_on_gui(self._show_out_of_token_dialog_on_main)

    def _on_token_replenished(self) -> None:
        """余额回正 (家长发奖 / 任务批准 / 第二天发放) → 关锁屏 + 切回 Child."""
        _log.info("★ 余额回正, 关锁屏 + 切回 Child 模式")
        try:
            self.session_manager.change_mode(
                SessionMode.CHILD.value, SessionEndReason.SWITCHED.value,
            )
        except Exception:
            _log.exception("切 Child 失败")
        get_bridge().run_on_gui(self._hide_out_of_token_dialog_on_main)

    def _show_out_of_token_dialog_on_main(self) -> None:
        try:
            from ui.assets import dialog_image_path
            if self.out_of_token_dialog is None:
                logo = str(dialog_image_path()) if dialog_image_path().exists() else None
                self.out_of_token_dialog = OutOfTokenDialog(
                    on_request=self._oot_on_request,
                    on_parent_unlock=self._oot_on_parent_unlock,
                    logo_path=logo,
                )
            self.out_of_token_dialog.show_for_user()
        except Exception:
            _log.exception("OutOfTokenDialog 显示失败")

    def _hide_out_of_token_dialog_on_main(self) -> None:
        if self.out_of_token_dialog is not None:
            try:
                self.out_of_token_dialog.hide_for_user()
            except Exception:
                _log.exception("OutOfTokenDialog 隐藏失败")

    def _oot_on_request(self) -> None:
        """孩子在锁屏上点"申请游戏时间" → 关锁屏 + 弹 RequestDialog."""
        if self.out_of_token_dialog is not None:
            self.out_of_token_dialog.hide_for_user()
        # 不切 Child (余额还是 0); 等家长批准后 temporary_unlock 才能玩
        self._show_request_dialog_on_main()

    def _oot_on_parent_unlock(self) -> None:
        """孩子在锁屏上点"家长 PIN 解锁" → bridge.ask_pin → 通过则切 Parent."""
        if not self.pin.has_pin():
            # 没设 PIN → 直接切 (家长信任本地物理在场)
            _log.warning("家长 PIN 未设置, 直接切 Parent 模式")
            self._switch_to_parent_after_unlock()
            return
        # 走 bridge ask_pin (会阻塞当前调用线程; 走 GUI 线程槽)
        try:
            from ui.assets import dialog_image_path
            logo = str(dialog_image_path()) if dialog_image_path().exists() else None
            ok = get_bridge().ask_pin(
                title="家长验证",
                prompt="输入家长 PIN 解锁切到家长模式 (不计费)",
                logo_path=logo,
                verify=self.pin.verify,
                on_wrong=lambda remaining: f"× PIN 错, 还剩 {remaining} 次",
                on_locked=lambda mins: f"× PIN 多次错误, 锁 {mins} 分钟",
                is_locked=self.pin.is_locked,
                seconds_until_unlock=self.pin.seconds_until_unlock,
                max_attempts=3,
            )
            if ok:
                self._switch_to_parent_after_unlock()
        except Exception:
            _log.exception("家长 PIN 解锁失败")

    def _switch_to_parent_after_unlock(self) -> None:
        """PIN 通过后: 关锁屏 + 切 Parent + 重置 token_engine 的 oot flag."""
        _log.info("★ 家长 PIN 通过, 切到 Parent 模式 (不计费)")
        if self.out_of_token_dialog is not None:
            self.out_of_token_dialog.hide_for_user()
        try:
            self.session_manager.change_mode(
                SessionMode.PARENT.value, SessionEndReason.SWITCHED.value,
            )
        except Exception:
            _log.exception("切 Parent 失败")
        # 不重置 token_engine._oot_triggered: 如果再切回 Child 且余额仍 0,
        # 应该再触发一次 (但通常家长会先发 token, 余额回正会自动 reset).
        try:
            self.notifier.info_async(
                "已切到家长模式, 不计费。\n做完事在托盘点「切回孩子模式」恢复。",
                title="NinoGame · 家长模式",
            )
        except Exception:
            pass

    def _switch_back_to_child(self) -> None:
        """托盘点"切回孩子模式" → 切回 Child (开始计费)。
        不要 PIN (切回是降权操作; 家长本人就在电脑前才会点)。
        如果余额仍 0, token_engine 下一个 tick 会再触发 OutOfTokenDialog 锁屏。
        """
        _log.info("★ 切回孩子模式 (恢复计费)")
        try:
            self.session_manager.change_mode(
                SessionMode.CHILD.value, SessionEndReason.SWITCHED.value,
            )
        except Exception:
            _log.exception("切回 Child 失败")
        try:
            self.notifier.info_async(
                "已切回孩子模式, 恢复计费。",
                title="NinoGame",
            )
        except Exception:
            pass

    def _send_token_tick(self, payload: dict) -> bool:
        """token_engine 每 tick 调; 把扣分意图推给 server 单一权威 (决策 #34)。
        返回 True = 已交给 transport 发出去 (并不代表 server 收到)。
        """
        if isinstance(self.transport, NullTransport):
            return False
        if not self.transport.is_connected():
            return False
        try:
            self.transport.send({
                "type": "token_tick",
                "payload": payload,
            })
            return True
        except Exception:
            _log.exception("send token_tick 失败")
            return False

    def _transport_warning(self) -> str | None:
        """共享给 dialog 用: 当前 transport 状态 → 用户可读的警告文案 (或 None 表示一切就绪)。"""
        if isinstance(self.transport, NullTransport):
            return (
                "Agent 还没配对家长后台 (离线模式)。\n"
                "现在点「发送」会失败。\n"
                "让爸妈在家长后台 → 设备页生成配对码, 然后托盘 →「重新配对家长后台...」"
            )
        if not self.transport.is_connected():
            return "WebSocket 已断开 (Agent 在自动重连)。等连接恢复后再发, 避免丢失。"
        return None

    def _submit_unlock_request(self, text: str) -> tuple[bool, str]:
        """RequestDialog 回调; 返回 (ok, message); 失败时 message 是具体原因。"""
        _log.info("[submit_unlock_request] 点击发送, text=%r", text[:60])
        if not text.strip():
            return False, "请先输入想说的话"
        if isinstance(self.transport, NullTransport):
            return False, (
                "Agent 还没配对家长后台 (离线模式)。\n"
                "让爸妈在家长后台 → 设备页生成配对码, 然后托盘 →「重新配对家长后台...」"
            )
        if not self.transport.is_connected():
            return False, "WebSocket 已断开 (Agent 会自动重连, 稍后再试)"
        try:
            self.transport.send({
                "type": "unlock_request",
                "payload": {
                    "request_text": text,
                    "structured": {},
                },
            })
            _log.info("已发送 unlock_request: %r", text[:60])
            return True, "已发送给家长。批准后浏览器会推命令过来, 你可以等通知, 或先去做别的事。"
        except Exception as e:
            _log.exception("发送 unlock_request 失败")
            return False, f"网络错误: {e}"

    def _request_show_messages_window(self) -> None:
        """托盘 → "我的消息..." 跨线程触发 (走 bridge 信号, 避免 worker 线程 timer 失败)。"""
        get_bridge().run_on_gui(self._show_messages_window_on_main)

    def _show_messages_window_on_main(self) -> None:
        try:
            from ui.assets import dialog_image_path
            if self.messages_window is None:
                logo = str(dialog_image_path()) if dialog_image_path().exists() else None
                self.messages_window = HistoryWindow(
                    title="NinoGame · 我的消息",
                    fetch_rows=lambda: self.notif_repo.list_recent(50),
                    render_row=render_notification_row,
                    empty_text="还没有收到任何通知。",
                    logo_path=logo,
                )
            self.messages_window.show_for_user()
        except Exception:
            _log.exception("MessagesWindow 显示失败")

    def _request_show_ledger_window(self) -> None:
        """托盘 → "查看余额变动..." 跨线程触发 (走 bridge 信号)。"""
        get_bridge().run_on_gui(self._show_ledger_window_on_main)

    def _show_ledger_window_on_main(self) -> None:
        try:
            from ui.assets import dialog_image_path
            if self.ledger_window is None:
                logo = str(dialog_image_path()) if dialog_image_path().exists() else None
                self.ledger_window = HistoryWindow(
                    title="NinoGame · 余额变动记录",
                    fetch_rows=lambda: self.wallet.list_recent_ledger(50),
                    render_row=render_ledger_row,
                    empty_text="还没有可显示的变动 (每分钟扣分不展示, 只看家长操作 + 任务奖励等)。",
                    logo_path=logo,
                )
            self.ledger_window.show_for_user()
        except Exception:
            _log.exception("LedgerWindow 显示失败")

    def _request_show_task_claim_dialog(self) -> None:
        """孩子在托盘点「申报任务完成」→ bridge 派发到 Qt 主线程 (同 _request_show_request_dialog)。"""
        get_bridge().run_on_gui(self._show_task_claim_dialog_on_main)

    def _show_task_claim_dialog_on_main(self) -> None:
        try:
            from ui.assets import dialog_image_path
            if self.task_claim_dialog is None:
                self.task_claim_dialog = TaskClaimDialog(
                    get_tasks=self._get_incentive_tasks,
                    on_submit=self._submit_task_claim,
                    logo_path=str(dialog_image_path()) if dialog_image_path().exists() else None,
                    get_transport_warning=self._transport_warning,
                )
            self.task_claim_dialog.show_for_user()
        except Exception:
            _log.exception("TaskClaimDialog 显示失败")

    def _get_incentive_tasks(self) -> list[dict]:
        """读 config/tasks.json, 返回所有 active 的 incentive 任务。
        责任类 (responsibility) 通过 tray 菜单的 checklist 完成, 不走这里。
        """
        tasks_path = self.config_dir / "tasks.json"
        if not tasks_path.exists():
            return []
        try:
            with open(tasks_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return [
                t for t in data
                if t.get("category") == "incentive" and t.get("active", True)
            ]
        except Exception:
            _log.exception("读 tasks.json 失败")
            return []

    def _submit_task_claim(self, task_id: str, child_note: str) -> tuple[bool, str]:
        """TaskClaimDialog 回调; 返回 (ok, message); 失败时 message 是具体原因。"""
        _log.info("[submit_task_claim] 点击申报, task_id=%s note=%r",
                  task_id, (child_note or "")[:40])
        if not task_id:
            return False, "任务 id 缺失 (内部错误)"
        if isinstance(self.transport, NullTransport):
            return False, (
                "Agent 还没配对家长后台 (离线模式)。\n"
                "让爸妈在家长后台 → 设备页生成配对码, 然后托盘 →「重新配对家长后台...」"
            )
        if not self.transport.is_connected():
            return False, "WebSocket 已断开 (Agent 会自动重连, 稍后再试)"
        try:
            self.transport.send({
                "type": "task_claim",
                "payload": {
                    "task_id": task_id,
                    "child_note": (child_note or "").strip()[:512],
                },
            })
            _log.info("已发送 task_claim: task_id=%s", task_id)
            return True, "已发送给家长。批准后浏览器会发奖励, 余额会自动更新。"
        except Exception as e:
            _log.exception("发送 task_claim 失败")
            return False, f"网络错误: {e}"

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
        """配对成功后热换 transport, 无需真重启 Agent 进程。

        日志里会看到 "WS 已连接 / hello / hello_ack" 等行, 看起来像新启动 ——
        但其实进程一直没断, 只是新的 WebSocketTransport 实例在跑握手。
        PID 没变, 内存里的 wallet / panel / overlay 都是同一个对象。
        """
        if not ok:
            return
        _log.info("=== 配对完成 (server=%s); 开始 transport 热换 (Agent 进程不重启) ===", server_url)
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

            _log.info("=== transport 热换完成 (Agent PID 未变); WebSocketTransport 已启动 ===")
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
            if self.task_claim_dialog is not None:
                self.task_claim_dialog.hide()
                self.task_claim_dialog.deleteLater()
        except Exception:
            pass
        try:
            if self.request_dialog is not None:
                self.request_dialog.hide()
                self.request_dialog.deleteLater()
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
