"""Token 计费引擎 (§10)。

每 tick (默认 60s) 检查前台进程：
  - consumption + active_consumption → 扣 token，写 segment
  - productive   + active_earning    → 加 token，写 segment，按日上限封顶
  - neutral / 闲置 / 后台 → 写 0 segment 或不写

每日硬上限（分钟）达到 → 直接 kill 前台 consumption 进程并弹警告。
余额不足 → 同样 kill + 提示。
"""
from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime
from typing import Callable

import psutil

from comms.event_bus import EventBus
from comms.message_types import (
    AppCategoryName,
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

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

        # 一旦在某 tick 内已经 kill 过该 pid，本 tick 不重复
        self._killed_this_tick: set[int] = set()

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
        self._killed_this_tick.clear()
        session_id = self._get_session_id()
        if not session_id:
            return  # Lock / Parent 模式不计费

        snap = self._get_foreground()
        if snap is None:
            return

        category = self._classify.classify(snap)
        now = datetime.utcnow()
        period_start = now
        period_end = now

        if category.category == AppCategoryName.CONSUMPTION.value:
            self._handle_consumption(
                snap, category, tick_seconds, session_id, period_start, period_end
            )
        elif category.category == AppCategoryName.PRODUCTIVE.value:
            self._handle_productive(
                snap, category, tick_seconds, session_id, period_start, period_end
            )
        else:
            # neutral：写零 segment 用于审计（可选）
            self._sessions.write_segment(AppSegment(
                session_id=session_id,
                app_identifier=snap.name.lower(),
                category=category.category,
                rate_multiplier=0.0,
                active_seconds=tick_seconds if self._activity.is_active_consumption() else 0,
                idle_seconds=0 if self._activity.is_active_consumption() else tick_seconds,
                period_start=period_start,
                period_end=period_end,
                tokens_consumed=0,
            ))

    # ── 消费 ─────────────────────────────────────────────────────
    def _handle_consumption(
        self,
        snap: ProcessSnapshot,
        category,
        tick_seconds: int,
        session_id: str,
        period_start: datetime,
        period_end: datetime,
    ) -> None:
        if not self._activity.is_active_consumption():
            # 后台 / 闲置：不扣
            self._sessions.write_segment(AppSegment(
                session_id=session_id,
                app_identifier=snap.name.lower(),
                category=category.category,
                rate_multiplier=category.rate_multiplier,
                active_seconds=0,
                idle_seconds=tick_seconds,
                period_start=period_start,
                period_end=period_end,
                tokens_consumed=0,
            ))
            return

        # 每日硬上限（分钟）检查
        used_seconds_today = self._sessions.today_consumption_seconds()
        cap_seconds = self._cfg.daily_hard_cap_minutes * 60
        if used_seconds_today >= cap_seconds:
            self._enforce_block(
                snap,
                reason_message=self._messages.get(
                    "block_daily_cap",
                    balance=self._wallet.get_balance(),
                    used_minutes=used_seconds_today // 60,
                    cap_minutes=self._cfg.daily_hard_cap_minutes,
                ),
                event_payload={
                    "kind": "daily_hard_cap",
                    "used_seconds": used_seconds_today,
                    "cap_seconds": cap_seconds,
                    "process_name": snap.name,
                    "pid": snap.pid,
                },
            )
            return

        # token 余额检查 + 扣分
        cost = self._cost_for_seconds(tick_seconds, category.rate_multiplier)
        if cost <= 0:
            self._sessions.write_segment(AppSegment(
                session_id=session_id,
                app_identifier=snap.name.lower(),
                category=category.category,
                rate_multiplier=category.rate_multiplier,
                active_seconds=tick_seconds,
                idle_seconds=0,
                period_start=period_start,
                period_end=period_end,
                tokens_consumed=0,
            ))
            return

        ok = self._wallet.deduct(
            cost,
            LedgerReason.APP_CONSUMPTION.value,
            ref_id=snap.name.lower(),
        )
        if not ok:
            self._enforce_block(
                snap,
                reason_message=self._messages.get(
                    "block_out_of_balance",
                    balance=self._wallet.get_balance(),
                    cost=cost,
                    process_name=snap.name,
                ),
                event_payload={
                    "kind": "out_of_balance",
                    "cost": cost,
                    "process_name": snap.name,
                    "pid": snap.pid,
                },
            )
            return

        self._sessions.write_segment(AppSegment(
            session_id=session_id,
            app_identifier=snap.name.lower(),
            category=category.category,
            rate_multiplier=category.rate_multiplier,
            active_seconds=tick_seconds,
            idle_seconds=0,
            period_start=period_start,
            period_end=period_end,
            tokens_consumed=cost,
        ))
        ev = Event(type=EventType.TOKEN_DEDUCT.value, payload={
            "amount": cost,
            "app": snap.name,
            "rate_multiplier": category.rate_multiplier,
            "balance_after": self._wallet.get_balance(),
        })
        self._events.emit(ev)
        self._bus.publish(ev)

    def _cost_for_seconds(self, seconds: int, rate: float) -> int:
        minutes = seconds / 60.0
        raw = minutes * self._cfg.token_to_minute_ratio * (rate or 1.0)
        # 不足 1 token 也四舍五入到 1，避免短停顿白嫖
        return max(0, int(math.ceil(raw)) if raw > 0 else 0)

    # ── 生产 ─────────────────────────────────────────────────────
    def _handle_productive(
        self,
        snap: ProcessSnapshot,
        category,
        tick_seconds: int,
        session_id: str,
        period_start: datetime,
        period_end: datetime,
    ) -> None:
        if not self._activity.is_active_earning():
            # 严格活跃失败：可能 jiggler
            self._sessions.write_segment(AppSegment(
                session_id=session_id,
                app_identifier=snap.name.lower(),
                category=category.category,
                rate_multiplier=category.rate_multiplier,
                active_seconds=0,
                idle_seconds=tick_seconds,
                period_start=period_start,
                period_end=period_end,
                tokens_consumed=0,
            ))
            return

        # 每日获取上限
        got_today = self._wallet.get_daily_credited()
        remaining = self._cfg.daily_credit_cap - got_today
        if remaining <= 0:
            self._sessions.write_segment(AppSegment(
                session_id=session_id,
                app_identifier=snap.name.lower(),
                category=category.category,
                rate_multiplier=category.rate_multiplier,
                active_seconds=tick_seconds,
                idle_seconds=0,
                period_start=period_start,
                period_end=period_end,
                tokens_consumed=0,
            ))
            return

        gain = self._gain_for_seconds(tick_seconds, category.rate_multiplier)
        gain = min(gain, remaining)
        if gain > 0:
            self._wallet.credit(
                gain,
                LedgerReason.PATH1_AUTO.value,
                ref_id=snap.name.lower(),
            )
            ev = Event(type=EventType.TOKEN_CREDIT.value, payload={
                "amount": gain,
                "app": snap.name,
                "category": category.category,
                "balance_after": self._wallet.get_balance(),
            })
            self._events.emit(ev)
            self._bus.publish(ev)

        self._sessions.write_segment(AppSegment(
            session_id=session_id,
            app_identifier=snap.name.lower(),
            category=category.category,
            rate_multiplier=category.rate_multiplier,
            active_seconds=tick_seconds,
            idle_seconds=0,
            period_start=period_start,
            period_end=period_end,
            tokens_consumed=-gain,  # 用负号标记 credit 方向
        ))

    def _gain_for_seconds(self, seconds: int, rate: float) -> int:
        minutes = seconds / 60.0
        raw = minutes * self._cfg.token_to_minute_ratio * (rate or 1.0)
        return max(0, int(round(raw)))

    # ── 拦截 ─────────────────────────────────────────────────────
    def _enforce_block(
        self,
        snap: ProcessSnapshot,
        reason_message: str,
        event_payload: dict,
    ) -> None:
        if snap.pid in self._killed_this_tick:
            return
        self._killed_this_tick.add(snap.pid)
        killed = False
        try:
            psutil.Process(snap.pid).kill()
            killed = True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        event_payload["killed"] = killed
        ev = Event(type=EventType.BLOCK.value, payload=event_payload)
        self._events.emit(ev)
        self._bus.publish(ev)
        self._notifier.warn_async(reason_message)
