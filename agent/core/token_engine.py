"""Token 计费引擎 (§10, 决策 #33 修订)。

每 tick (默认 60s):
  child + 活跃 + 非限免 + 未达硬上限 + 余额>0 → 扣 cost(=ratio*tick/60)
  否则不扣, 走 skip_reason 路径 (emit STATUS 让浏览器看到)

不再按 consumption / productive 分类决定扣不扣; Path 1 自动挣分已下线。
classifier 仍调一次拿 segment.category 标签 (审计 + 未来扩展, 不参与决策)。
余额耗尽 / 硬上限不 kill 进程, 仅一天一次通知 + emit STATUS。
"""
from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime
from typing import Callable

from comms.event_bus import EventBus
from comms.message_types import (
    AppSegment,
    Event,
    EventType,
    LedgerReason,
    ProcessSnapshot,
)
from core.activity_detector import ActivityDetector
from core.classifier import Classifier
from core.messages import Messages
from store.repository import (
    EventSink,
    SessionRepository,
    WalletService,
)
from ui.notifier import Notifier

_log = logging.getLogger(__name__)


class TokenEngineConfig:
    def __init__(
        self,
        billing_tick_seconds: int = 60,
        daily_hard_cap_minutes: int = 120,
        daily_credit_cap: int = 120,
        token_to_minute_ratio: float = 1.0,
    ) -> None:
        self.billing_tick_seconds = billing_tick_seconds
        self.daily_hard_cap_minutes = daily_hard_cap_minutes
        self.daily_credit_cap = daily_credit_cap
        self.token_to_minute_ratio = token_to_minute_ratio


class TokenEngine:
    """长期运行的 tick loop。

    依赖通过构造器全部注入，不直接读全局。
    """

    def __init__(
        self,
        config: TokenEngineConfig,
        get_foreground: Callable[[], ProcessSnapshot | None],
        classifier: Classifier,
        wallet: WalletService,
        sessions: SessionRepository,
        events: EventSink,
        bus: EventBus,
        notifier: Notifier,
        activity: ActivityDetector,
        messages: Messages,
        get_active_session_id: Callable[[], str | None],
        is_free_pass_active: Callable[[], bool] | None = None,
        send_token_tick: Callable[[dict], bool] | None = None,
        on_out_of_token: Callable[[], None] | None = None,
        on_token_replenished: Callable[[], None] | None = None,
    ) -> None:
        self._cfg = config
        self._get_foreground = get_foreground
        self._classify = classifier
        self._wallet = wallet
        self._sessions = sessions
        self._events = events
        self._bus = bus
        self._notifier = notifier
        self._activity = activity
        self._messages = messages
        self._get_session_id = get_active_session_id
        self._is_free_pass_active = is_free_pass_active or (lambda: False)
        # WS 推 token_tick 到 server (server 单一权威 #34); None → 离线模式不扣
        self._send_token_tick = send_token_tick or (lambda payload: False)
        # 余额耗尽 / 回正 callback: main.py 用来弹全屏锁屏 / 关闭锁屏 + 切模式
        self._on_out_of_token = on_out_of_token
        self._on_token_replenished = on_token_replenished
        self._oot_triggered: bool = False  # 0 余额状态去重 flag

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

        # 一旦在某 tick 内已经 kill 过该 pid，本 tick 不重复
        self._killed_this_tick: set[int] = set()

        # (kind, date) 集合: daily_cap / out_of_balance 这种"全天同一原因"的
        # 通知一天只弹一次, 避免每 60s 一次刷屏
        self._notified_today: set[tuple[str, str]] = set()

    # ── 启停 ─────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="token-engine", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    # ── 主循环 ───────────────────────────────────────────────────
    def _loop(self) -> None:
        tick = self._cfg.billing_tick_seconds
        next_tick = time.monotonic() + tick
        while not self._stop.is_set():
            now = time.monotonic()
            if now < next_tick:
                self._stop.wait(min(1.0, next_tick - now))
                continue
            try:
                self._tick(tick)
            except Exception:
                _log.exception("token engine tick failed")
            next_tick = time.monotonic() + tick

    def _tick(self, tick_seconds: int) -> None:
        """统一在线时长扣分 (CLAUDE.md §22 决策 #33)。

        child + 活跃 + 非限免 + 未达硬上限 + 余额>0 → 扣 cost。
        不再按 consumption / productive 分类决定扣不扣; 任何前台都按时长扣。
        余额耗尽 / 硬上限 不再 kill 进程, 仅通知 + emit STATUS。
        """
        self._killed_this_tick.clear()
        session_id = self._get_session_id()
        if not session_id:
            _log.info("[tick] 跳过: Lock / Parent 模式 (不计费)")
            self._emit_decision(
                foreground=None, category=None, mode_active=False,
                deducted=0, skip_reason="mode_off",
            )
            return

        # 拿前台仅用于在 segment / STATUS 里展示 "正在用什么"; 不影响扣分判定
        snap = self._get_foreground()
        # 顺手填 segment.category 标签 (审计 + 未来 LLM 扩展用), 不参与决策
        category_label: str = "unknown"
        if snap is not None:
            try:
                category_label = self._classify.classify(snap).category
            except Exception:
                category_label = "unknown"

        now = datetime.utcnow()
        period_start = now
        period_end = now
        fg_name = snap.name if snap else None
        app_id = (snap.name.lower() if snap else "(no_foreground)")

        # 限免活动: 跳扣
        if self._is_free_pass_active():
            _log.info("[tick] 限免活动中 → 跳过扣 token (前台=%s)", fg_name or "—")
            self._write_segment(session_id, app_id, category_label, tick_seconds, 0, 0,
                                period_start, period_end)
            self._emit_decision(foreground=fg_name, category=category_label,
                                mode_active=True, deducted=0, skip_reason="free_pass")
            return

        # 决策 #36: 不再判定活跃, child 模式在跑就扣。理由: 用户报
        # "不管什么情况, 模式在运行就要扣费"。闲置 10 分钟仍会自动 Lock 停扣,
        # 真正离开屏幕的场景由 idle Lock 兜底。

        # 每日硬上限 (决策 #35: 默认 0 = 不限。家长可在 settings.json 设非 0 启用)
        if self._cfg.daily_hard_cap_minutes > 0:
            used_seconds_today = self._sessions.today_consumption_seconds()
            cap_seconds = self._cfg.daily_hard_cap_minutes * 60
            if used_seconds_today >= cap_seconds:
                _log.info("[tick] 已达每日硬上限 (%d/%d 分钟) → 不扣 (前台=%s)",
                          used_seconds_today // 60, self._cfg.daily_hard_cap_minutes,
                          fg_name or "—")
                self._notify_once_per_day("daily_cap", self._messages.get(
                    "block_daily_cap",
                    balance=self._wallet.get_balance(),
                    used_minutes=used_seconds_today // 60,
                    cap_minutes=self._cfg.daily_hard_cap_minutes,
                ))
                self._write_segment(session_id, app_id, category_label, tick_seconds, 0, 0,
                                    period_start, period_end)
                self._emit_decision(foreground=fg_name, category=category_label,
                                    mode_active=True, deducted=0, skip_reason="daily_cap")
                return

        # 计算 cost (统一 ratio, 不再 *rate_multiplier)
        cost = self._cost_for_seconds(tick_seconds, 1.0)
        if cost <= 0:
            self._write_segment(session_id, app_id, category_label, tick_seconds, 0, 0,
                                period_start, period_end)
            self._emit_decision(foreground=fg_name, category=category_label,
                                mode_active=True, deducted=0, skip_reason="zero_cost")
            return

        # 余额检查 (用 local cache, server 最近一次推过来的值; 防止过冲)
        cur_balance = self._wallet.get_balance()
        if cur_balance < cost:
            _log.info("[tick] 余额不足 (local=%d, cost=%d), 触发余额耗尽锁屏 "
                      "(oot_triggered=%s, has_callback=%s)",
                      cur_balance, cost, self._oot_triggered,
                      self._on_out_of_token is not None)
            # 第一次进入耗尽态 → 通知 main.py 弹全屏锁屏 + 切 Lock 模式
            if not self._oot_triggered and self._on_out_of_token is not None:
                self._oot_triggered = True
                _log.info("★ 余额耗尽 → 调 on_out_of_token 回调")
                try:
                    self._on_out_of_token()
                except Exception:
                    _log.exception("on_out_of_token 回调失败")
            elif self._on_out_of_token is None:
                _log.warning("余额耗尽但 on_out_of_token callback 未注入! main.py 检查注入路径")
            self._write_segment(session_id, app_id, category_label, tick_seconds, 0, 0,
                                period_start, period_end)
            self._emit_decision(foreground=fg_name, category=category_label,
                                mode_active=True, deducted=0, skip_reason="out_of_balance")
            return

        # 余额充足 → 如果之前是耗尽态, 通知 main.py 关锁屏 + 切回 Child
        if self._oot_triggered:
            self._oot_triggered = False
            if self._on_token_replenished is not None:
                try:
                    self._on_token_replenished()
                except Exception:
                    _log.exception("on_token_replenished 回调失败")

        # 决策 #34: 推 WS token_tick 让 server 单一权威扣分; Agent 本地不再 deduct。
        # transport 没连接时跳过 (孩子离线时停扣, 与 CLAUDE.md §7.6 一致)。
        sent = False
        try:
            sent = bool(self._send_token_tick({
                "amount": cost,
                "ref_id": app_id,
                "app": fg_name or "",
                "tick_seconds": tick_seconds,
            }))
        except Exception:
            _log.exception("send_token_tick 失败")
        if not sent:
            _log.info("[tick] transport 未连, 跳过扣分 (前台=%s)", fg_name or "—")
            self._write_segment(session_id, app_id, category_label, tick_seconds, 0, 0,
                                period_start, period_end)
            self._emit_decision(foreground=fg_name, category=category_label,
                                mode_active=True, deducted=0, skip_reason="transport_offline")
            return

        # 已通过 WS 通知 server, 写本地审计 segment (tokens_consumed=cost 表"server 应该扣这么多")。
        # local balance 会在 server 推 wallet_update 回来时被对齐, 不在这里 deduct。
        self._write_segment(session_id, app_id, category_label, tick_seconds, 0, cost,
                            period_start, period_end)
        _log.info("★ 已推 token_tick: -%d (前台=%s), 等 server wallet_update 同步余额",
                  cost, fg_name or "—")
        ev = Event(type=EventType.TOKEN_DEDUCT.value, payload={
            "amount": cost,
            "app": fg_name or "",
            "balance_after": cur_balance,  # 乐观显示; server 真实值随后到
        })
        self._events.emit(ev)
        self._bus.publish(ev)
        self._emit_decision(foreground=fg_name, category=category_label,
                            mode_active=True, deducted=cost, skip_reason=None)

    def _write_segment(
        self,
        session_id: str,
        app_identifier: str,
        category: str,
        active_seconds: int,
        idle_seconds: int,
        tokens_consumed: int,
        period_start: datetime,
        period_end: datetime,
    ) -> None:
        self._sessions.write_segment(AppSegment(
            session_id=session_id,
            app_identifier=app_identifier,
            category=category,
            rate_multiplier=1.0,
            active_seconds=active_seconds,
            idle_seconds=idle_seconds,
            period_start=period_start,
            period_end=period_end,
            tokens_consumed=tokens_consumed,
        ))

    def _notify_once_per_day(self, kind: str, message: str) -> None:
        """daily_cap / out_of_balance 这种 "持续不变" 的事一天最多通知一次,
        避免每分钟 tick 都弹。用 set 记 (kind+date)。"""
        today_key = (kind, datetime.utcnow().date().isoformat())
        if today_key in self._notified_today:
            return
        self._notified_today.add(today_key)
        try:
            self._notifier.warn_async(message)
        except Exception:
            _log.exception("notify failed: %s", kind)

    def _emit_decision(
        self,
        *,
        foreground: str | None,
        category: str | None,
        mode_active: bool,
        deducted: int,
        skip_reason: str | None,
    ) -> None:
        """每 tick 末尾发一条 STATUS, 告诉 server 浏览器 "本 tick 扣不扣 / 原因"。
        浏览器实时面板会订阅。决策 #33 后字段简化:
          - 删 rate (统一 1.0)
          - 删 credited (Path 1 下线)
        """
        ev = Event(type=EventType.STATUS.value, payload={
            "kind": "token_decision",
            "foreground": foreground,
            "category": category,  # 仅审计标签, 不参与决策
            "mode_active": mode_active,
            "balance": self._wallet.get_balance(),
            "deducted": deducted,
            "skip_reason": skip_reason,
        })
        try:
            self._events.emit(ev)
            self._bus.publish(ev)
        except Exception:
            _log.exception("emit decision status failed")

    def _cost_for_seconds(self, seconds: int, rate: float) -> int:
        """统一按 ratio 折算 token; rate 形参保留是为了 (未来) 个别应用费率差异化,
        当前所有 caller 传 1.0。"""
        minutes = seconds / 60.0
        raw = minutes * self._cfg.token_to_minute_ratio * (rate or 1.0)
        # 不足 1 token 也四舍五入到 1，避免短停顿白嫖
        return max(0, int(math.ceil(raw)) if raw > 0 else 0)
