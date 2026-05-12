"""Repository / Service 接口契约 (§17.5.4)。

业务模块（core/*）只依赖这些接口。
P1 注入 local_sqlite.* 实现，P2 直接替换为 BackendXxx 实现，core/ 零改动。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date, datetime
from typing import Callable

from comms.message_types import (
    AppCategory,
    AppSegment,
    Event,
    LedgerEntry,
    Rule,
    Session,
)


class RuleRepository(ABC):
    """规则集读写。

    P1: JSON file + 进程内缓存
    P2: 内存缓存 + 订阅服务端 rules_update
    """

    @abstractmethod
    def get_all(self) -> list[Rule]: ...

    @abstractmethod
    def get(self, rule_id: str) -> Rule | None: ...

    @abstractmethod
    def save(self, rule: Rule) -> None: ...

    @abstractmethod
    def reload(self) -> None:
        """强制重读底层存储（外部编辑了配置文件时）。"""

    @abstractmethod
    def subscribe_changes(self, callback: Callable[[list[Rule]], None]) -> None: ...


class AppCategoryRepository(ABC):
    """应用分类查询。"""

    @abstractmethod
    def get(self, app_identifier: str) -> AppCategory | None: ...

    @abstractmethod
    def upsert(self, category: AppCategory) -> None: ...

    @abstractmethod
    def all_consumption(self) -> list[AppCategory]: ...


class WalletService(ABC):
    """钱包服务（P1 SQLite / P2 写穿透后端）。"""

    @abstractmethod
    def get_balance(self) -> int: ...

    @abstractmethod
    def deduct(self, amount: int, reason: str, ref_id: str | None = None) -> bool:
        """扣分。返回 False 表示余额不足（不会扣到负值）。"""

    @abstractmethod
    def credit(self, amount: int, reason: str, ref_id: str | None = None) -> None: ...

    @abstractmethod
    def get_daily_consumed(self) -> int: ...

    @abstractmethod
    def get_daily_credited(self, reason: str | None = None) -> int:
        """指定 reason 当日累计 credit；reason=None 表示所有正向。
        用来做"每日 token 获取上限"判断。"""

    @abstractmethod
    def ensure_daily_grant(self, base_amount: int, today: date) -> int:
        """如果今日还没领过 daily_grant，credit base_amount，返回实际发放量；否则返回 0。"""

    @abstractmethod
    def recent_ledger(self, limit: int = 50) -> list[LedgerEntry]: ...


class EventSink(ABC):
    """事件吸收器（P1 写本地 SQLite / P2 同时写本地 + Transport 上报）。"""

    @abstractmethod
    def emit(self, event: Event) -> None: ...


class SessionRepository(ABC):
    """会话存储。"""

    @abstractmethod
    def open_session(self, session: Session) -> None: ...

    @abstractmethod
    def close_session(
        self,
        session_id: str,
        ended_at: datetime,
        end_reason: str,
        total_active_seconds: int,
        total_tokens_consumed: int,
    ) -> None: ...

    @abstractmethod
    def write_segment(self, segment: AppSegment) -> None: ...

    @abstractmethod
    def today_consumption_seconds(self) -> int:
        """今日所有 category='consumption' 片段累计 active_seconds，
        用于强制每日硬上限 (§7.4)。"""


class UnknownAppQueue(ABC):
    """未知 App 排队，等 P2 后端 LLM 分类。"""

    @abstractmethod
    def enqueue(
        self,
        app_identifier: str,
        exe_path: str,
        window_title: str,
        first_seen_at: datetime,
    ) -> None: ...


class ResponsibilityRepository(ABC):
    """责任清单完成情况。"""

    @abstractmethod
    def tick(self, task_id: str, on_date: date, completed: bool) -> None: ...

    @abstractmethod
    def get_today(self, today: date) -> dict[str, bool]: ...
