"""所有跨模块传递的数据契约 (dataclass)。

约定：
- core/* 通过这些类型互相通信，永不传 dict
- P1→P2 升级时 message_types 保持兼容，只新增字段不改语义
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Any


# ────────────────────────────────────────────────────────────────
# 枚举
# ────────────────────────────────────────────────────────────────
class MatcherField(str, Enum):
    PROCESS_NAME = "process_name"
    EXE_PATH = "exe_path"
    WINDOW_TITLE = "window_title"
    COMMAND_LINE = "command_line"


class MatcherOp(str, Enum):
    EQUALS = "equals"
    IEQUALS = "iequals"
    CONTAINS = "contains"
    ICONTAINS = "icontains"
    REGEX = "regex"


class MatcherLogic(str, Enum):
    OR = "OR"
    AND = "AND"


class ScheduleMode(str, Enum):
    ALWAYS = "always"
    WINDOWED = "windowed"
    DISABLED = "disabled"


class ActionType(str, Enum):
    KILL_AND_WARN = "kill_and_warn"
    KILL_SILENT = "kill_silent"
    WARN_ONLY = "warn_only"


class AppCategoryName(str, Enum):
    CONSUMPTION = "consumption"
    NEUTRAL = "neutral"
    PRODUCTIVE = "productive"


class SessionMode(str, Enum):
    CHILD = "child"
    PARENT = "parent"
    LIMITED_FREE = "limited_free"
    LOCK = "lock"


class SessionEndReason(str, Enum):
    MANUAL_LOCK = "manual_lock"
    IDLE = "idle"
    SHUTDOWN = "shutdown"
    SWITCHED = "switched"


# ────────────────────────────────────────────────────────────────
# 进程快照
# ────────────────────────────────────────────────────────────────
@dataclass
class ProcessSnapshot:
    """一次扫描的单个进程数据。"""
    pid: int
    name: str
    exe_path: str = ""
    window_titles: list[str] = field(default_factory=list)
    command_line: str = ""

    def text_for_field(self, field_name: str) -> str | list[str]:
        if field_name == MatcherField.PROCESS_NAME.value:
            return self.name
        if field_name == MatcherField.EXE_PATH.value:
            return self.exe_path
        if field_name == MatcherField.WINDOW_TITLE.value:
            return self.window_titles
        if field_name == MatcherField.COMMAND_LINE.value:
            return self.command_line
        return ""


# ────────────────────────────────────────────────────────────────
# 规则
# ────────────────────────────────────────────────────────────────
@dataclass
class Matcher:
    field: str          # MatcherField
    op: str             # MatcherOp
    value: str


@dataclass
class Schedule:
    mode: str = ScheduleMode.ALWAYS.value
    windows: list[dict] = field(default_factory=list)  # P3+


@dataclass
class RuleAction:
    type: str = ActionType.KILL_AND_WARN.value
    message: str = ""


@dataclass
class Rule:
    id: str
    name: str
    enabled: bool = True
    matchers: list[Matcher] = field(default_factory=list)
    matcher_logic: str = MatcherLogic.OR.value
    exclude_processes: list[str] = field(default_factory=list)
    schedule: Schedule = field(default_factory=Schedule)
    action: RuleAction = field(default_factory=RuleAction)
    category_link: str = ""
    notify_parent: bool = True

    @staticmethod
    def from_dict(d: dict) -> "Rule":
        return Rule(
            id=d["id"],
            name=d.get("name", ""),
            enabled=d.get("enabled", True),
            matchers=[Matcher(**m) for m in d.get("matchers", [])],
            matcher_logic=d.get("matcher_logic", MatcherLogic.OR.value),
            exclude_processes=list(d.get("exclude_processes", [])),
            schedule=Schedule(**d.get("schedule", {})),
            action=RuleAction(**d.get("action", {})),
            category_link=d.get("category_link", ""),
            notify_parent=d.get("notify_parent", True),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class MatchResult:
    rule: Rule
    process: ProcessSnapshot
    reason: str          # 人类可读的命中描述


# ────────────────────────────────────────────────────────────────
# 应用分类
# ────────────────────────────────────────────────────────────────
@dataclass
class AppCategory:
    app_identifier: str           # 通常是 process name lowercase
    category: str                 # AppCategoryName
    sub_type: str = ""            # game / video / reading / learning / ...
    rate_multiplier: float = 1.0
    source: str = "seed"          # seed / user / llm

    @staticmethod
    def from_dict(d: dict) -> "AppCategory":
        return AppCategory(
            app_identifier=d["app_identifier"].lower(),
            category=d.get("category", AppCategoryName.NEUTRAL.value),
            sub_type=d.get("sub_type", ""),
            rate_multiplier=float(d.get("rate_multiplier", 1.0)),
            source=d.get("source", "seed"),
        )


# ────────────────────────────────────────────────────────────────
# 事件（审计日志）
# ────────────────────────────────────────────────────────────────
class EventType(str, Enum):
    BLOCK = "block"
    HEARTBEAT = "heartbeat"
    STATUS = "status"
    SESSION_OPEN = "session_open"
    SESSION_CLOSE = "session_close"
    PIN_FAIL = "pin_fail"
    PIN_LOCKED = "pin_locked"
    JIGGLER_ALERT = "jiggler_alert"
    TOKEN_DEDUCT = "token_deduct"
    TOKEN_CREDIT = "token_credit"
    DAILY_GRANT = "daily_grant"
    UNKNOWN_APP = "unknown_app"
    CHECKLIST_TICK = "checklist_tick"


@dataclass
class Event:
    type: str                              # EventType
    payload: dict[str, Any] = field(default_factory=dict)
    occurred_at: datetime = field(default_factory=datetime.utcnow)


# ────────────────────────────────────────────────────────────────
# 会话
# ────────────────────────────────────────────────────────────────
@dataclass
class Session:
    id: str
    mode: str
    started_at: datetime
    ended_at: datetime | None = None
    end_reason: str = ""
    total_active_seconds: int = 0
    total_tokens_consumed: int = 0


# ────────────────────────────────────────────────────────────────
# 5min 使用上报片段（P2 上报用，P1 也先按这个结构写本地）
# ────────────────────────────────────────────────────────────────
@dataclass
class AppSegment:
    session_id: str
    app_identifier: str
    category: str
    rate_multiplier: float
    active_seconds: int
    idle_seconds: int
    period_start: datetime
    period_end: datetime
    tokens_consumed: int = 0


# ────────────────────────────────────────────────────────────────
# 钱包变动条目
# ────────────────────────────────────────────────────────────────
class LedgerReason(str, Enum):
    DAILY_GRANT = "daily_grant"
    TASK_REWARD = "task_reward"
    PATH1_AUTO = "path1_auto"
    APP_CONSUMPTION = "app_consumption"
    UNLOCK_PREPAY = "unlock_prepay"
    REFUND = "refund"
    PARENT_GRANT = "parent_grant"
    STREAK_BONUS = "streak_bonus"
    ADJUSTMENT = "adjustment"


@dataclass
class LedgerEntry:
    id: int
    delta: int
    balance_after: int
    reason: str
    ref_id: str | None
    occurred_at: datetime
