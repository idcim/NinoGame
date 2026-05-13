"""P1 Repository / Service SQLite 实现。

约定：
- 一个 connection per repository 对象，调用方负责生命周期
- 所有写入都 commit；没有显式事务跨多个方法的需求
- synced_to_server 永远写 0（P1）；P2 再补
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Callable

from comms.message_types import (
    AppCategory,
    AppSegment,
    Event,
    LedgerEntry,
    LedgerReason,
    Rule,
    Session,
)
from store.repository import (
    AppCategoryRepository,
    EventSink,
    ResponsibilityRepository,
    RuleRepository,
    SessionRepository,
    UnknownAppQueue,
    WalletService,
)

_log = logging.getLogger(__name__)
_SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def open_db(db_path: str | os.PathLike) -> sqlite3.Connection:
    """打开（必要时创建）SQLite 库，应用 schema.sql。"""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(db_path),
        detect_types=sqlite3.PARSE_DECLTYPES,
        check_same_thread=False,
        isolation_level=None,  # autocommit; 我们手动 BEGIN/COMMIT
    )
    conn.row_factory = sqlite3.Row
    with open(_SCHEMA_PATH, "r", encoding="utf-8") as f:
        conn.executescript(f.read())
    # 保证 wallet 单行存在
    conn.execute(
        "INSERT OR IGNORE INTO wallet (id, balance) VALUES (1, 0)"
    )
    return conn


# ────────────────────────────────────────────────────────────────
# 规则：P1 用 config/rules.json 作为权威源；DB 不存
# 这样家长（即你）可以直接编辑 JSON，更适合 P1 单机版
# ────────────────────────────────────────────────────────────────
class JsonRuleRepository(RuleRepository):
    def __init__(self, json_path: str | os.PathLike) -> None:
        self._path = Path(json_path)
        self._lock = threading.Lock()
        self._cache: list[Rule] = []
        self._subscribers: list[Callable[[list[Rule]], None]] = []
        self._mtime: float = 0.0
        self.reload()

    def _load_from_disk(self) -> list[Rule]:
        if not self._path.exists():
            return []
        with open(self._path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return [Rule.from_dict(d) for d in raw]

    def _save_to_disk(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(
                [r.to_dict() for r in self._cache],
                f,
                ensure_ascii=False,
                indent=2,
            )
        self._mtime = self._path.stat().st_mtime

    def reload(self) -> None:
        with self._lock:
            self._cache = self._load_from_disk()
            self._mtime = self._path.stat().st_mtime if self._path.exists() else 0.0
        for cb in list(self._subscribers):
            try:
                cb(self.get_all())
            except Exception:
                _log.exception("rule subscriber failed")

    def reload_if_changed(self) -> bool:
        """供轮询调用：文件被外部修改时返回 True 并重新加载。"""
        if not self._path.exists():
            return False
        mtime = self._path.stat().st_mtime
        if mtime > self._mtime:
            self.reload()
            return True
        return False

    def get_all(self) -> list[Rule]:
        with self._lock:
            return list(self._cache)

    def get(self, rule_id: str) -> Rule | None:
        with self._lock:
            for r in self._cache:
                if r.id == rule_id:
                    return r
        return None

    def save(self, rule: Rule) -> None:
        with self._lock:
            for i, r in enumerate(self._cache):
                if r.id == rule.id:
                    self._cache[i] = rule
                    break
            else:
                self._cache.append(rule)
            self._save_to_disk()
        for cb in list(self._subscribers):
            try:
                cb(self.get_all())
            except Exception:
                _log.exception("rule subscriber failed")

    def replace_all(self, rules: list[Rule]) -> None:
        """服务器推 rules_update 时用; 整体覆盖。"""
        with self._lock:
            self._cache = list(rules)
            self._save_to_disk()
        for cb in list(self._subscribers):
            try:
                cb(self.get_all())
            except Exception:
                _log.exception("rule subscriber failed")

    def subscribe_changes(self, callback: Callable[[list[Rule]], None]) -> None:
        self._subscribers.append(callback)


# ────────────────────────────────────────────────────────────────
# 应用分类
# ────────────────────────────────────────────────────────────────
class SqliteAppCategoryRepository(AppCategoryRepository):
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def get(self, app_identifier: str) -> AppCategory | None:
        row = self._conn.execute(
            "SELECT app_identifier, category, sub_type, rate_multiplier, source "
            "FROM app_categories WHERE app_identifier = ?",
            (app_identifier.lower(),),
        ).fetchone()
        if not row:
            return None
        return AppCategory(
            app_identifier=row["app_identifier"],
            category=row["category"],
            sub_type=row["sub_type"] or "",
            rate_multiplier=float(row["rate_multiplier"] or 1.0),
            source=row["source"] or "seed",
        )

    def upsert(self, category: AppCategory) -> None:
        self._conn.execute(
            "INSERT INTO app_categories (app_identifier, category, sub_type, rate_multiplier, source, updated_at) "
            "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(app_identifier) DO UPDATE SET "
            "  category=excluded.category, "
            "  sub_type=excluded.sub_type, "
            "  rate_multiplier=excluded.rate_multiplier, "
            "  source=excluded.source, "
            "  updated_at=CURRENT_TIMESTAMP",
            (
                category.app_identifier.lower(),
                category.category,
                category.sub_type,
                category.rate_multiplier,
                category.source,
            ),
        )

    def all_consumption(self) -> list[AppCategory]:
        rows = self._conn.execute(
            "SELECT app_identifier, category, sub_type, rate_multiplier, source "
            "FROM app_categories WHERE category = 'consumption'"
        ).fetchall()
        return [
            AppCategory(
                app_identifier=r["app_identifier"],
                category=r["category"],
                sub_type=r["sub_type"] or "",
                rate_multiplier=float(r["rate_multiplier"] or 1.0),
                source=r["source"] or "seed",
            )
            for r in rows
        ]


# ────────────────────────────────────────────────────────────────
# 钱包
# ────────────────────────────────────────────────────────────────
class SqliteWalletService(WalletService):
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()

    def get_balance(self) -> int:
        row = self._conn.execute("SELECT balance FROM wallet WHERE id = 1").fetchone()
        return int(row["balance"]) if row else 0

    def _write_ledger(
        self,
        delta: int,
        new_balance: int,
        reason: str,
        ref_id: str | None,
    ) -> None:
        self._conn.execute(
            "INSERT INTO token_ledger (delta, balance_after, reason, ref_id) "
            "VALUES (?, ?, ?, ?)",
            (delta, new_balance, reason, ref_id),
        )
        self._conn.execute(
            "UPDATE wallet SET balance = ? WHERE id = 1", (new_balance,)
        )

    def deduct(self, amount: int, reason: str, ref_id: str | None = None) -> bool:
        if amount <= 0:
            return True
        with self._lock:
            balance = self.get_balance()
            if balance < amount:
                return False
            new_balance = balance - amount
            self._conn.execute("BEGIN")
            try:
                self._write_ledger(-amount, new_balance, reason, ref_id)
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        return True

    def credit(self, amount: int, reason: str, ref_id: str | None = None) -> None:
        if amount <= 0:
            return
        with self._lock:
            balance = self.get_balance()
            new_balance = balance + amount
            self._conn.execute("BEGIN")
            try:
                self._write_ledger(amount, new_balance, reason, ref_id)
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def get_daily_consumed(self) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(SUM(-delta), 0) AS used FROM token_ledger "
            "WHERE delta < 0 "
            "AND date(occurred_at, 'localtime') = date('now', 'localtime')"
        ).fetchone()
        return int(row["used"] or 0)

    def get_daily_credited(self, reason: str | None = None) -> int:
        if reason is None:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(delta), 0) AS got FROM token_ledger "
                "WHERE delta > 0 "
                "AND date(occurred_at, 'localtime') = date('now', 'localtime')"
            ).fetchone()
        else:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(delta), 0) AS got FROM token_ledger "
                "WHERE delta > 0 AND reason = ? "
                "AND date(occurred_at, 'localtime') = date('now', 'localtime')",
                (reason,),
            ).fetchone()
        return int(row["got"] or 0)

    def ensure_daily_grant(self, base_amount: int, today: date) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT last_daily_grant_date FROM wallet WHERE id = 1"
            ).fetchone()
            last_raw = row["last_daily_grant_date"] if row else None
            # 关键: sqlite3 用 detect_types=PARSE_DECLTYPES, DATE 列
            # 读出来是 datetime.date 对象, 不是 str。统一规范化成
            # date 后再比, 避免 date == "2026-05-13" 永远 False
            # 导致每次启动都重发。
            last_date: date | None = None
            if isinstance(last_raw, date):
                last_date = last_raw
            elif isinstance(last_raw, str) and last_raw:
                try:
                    last_date = date.fromisoformat(last_raw)
                except ValueError:
                    last_date = None
            today_str = today.isoformat()
            if last_date == today:
                return 0
            if base_amount > 0:
                self._conn.execute("BEGIN")
                try:
                    balance = self.get_balance()
                    new_balance = balance + base_amount
                    self._write_ledger(
                        base_amount, new_balance, LedgerReason.DAILY_GRANT.value, None
                    )
                    self._conn.execute(
                        "UPDATE wallet SET last_daily_grant_date = ? WHERE id = 1",
                        (today_str,),
                    )
                    self._conn.execute("COMMIT")
                except Exception:
                    self._conn.execute("ROLLBACK")
                    raise
            else:
                self._conn.execute(
                    "UPDATE wallet SET last_daily_grant_date = ? WHERE id = 1",
                    (today_str,),
                )
            return base_amount

    def sync_balance(self, server_balance: int, reason: str = "server_sync") -> int:
        """把本地余额对齐到服务器值; 写一笔 adjustment ledger 记 delta。"""
        with self._lock:
            local = self.get_balance()
            delta = int(server_balance) - int(local)
            if delta == 0:
                return 0
            self._conn.execute("BEGIN")
            try:
                self._write_ledger(delta, int(server_balance), reason, None)
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        return delta

    def recent_ledger(self, limit: int = 50) -> list[LedgerEntry]:
        rows = self._conn.execute(
            "SELECT id, delta, balance_after, reason, ref_id, occurred_at "
            "FROM token_ledger ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            LedgerEntry(
                id=r["id"],
                delta=r["delta"],
                balance_after=r["balance_after"],
                reason=r["reason"],
                ref_id=r["ref_id"],
                occurred_at=_parse_ts(r["occurred_at"]),
            )
            for r in rows
        ]


def _parse_ts(value) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        # SQLite CURRENT_TIMESTAMP 默认 'YYYY-MM-DD HH:MM:SS'
        try:
            return datetime.fromisoformat(value.replace(" ", "T"))
        except ValueError:
            return datetime.utcnow()
    return datetime.utcnow()


# ────────────────────────────────────────────────────────────────
# 事件
# ────────────────────────────────────────────────────────────────
class SqliteEventSink(EventSink):
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def emit(self, event: Event) -> None:
        try:
            self._conn.execute(
                "INSERT INTO events (event_type, payload, occurred_at) VALUES (?, ?, ?)",
                (
                    event.type,
                    json.dumps(event.payload, ensure_ascii=False, default=str),
                    event.occurred_at.isoformat(sep=" ", timespec="seconds"),
                ),
            )
        except Exception:
            _log.exception("failed to persist event %s", event.type)


# ────────────────────────────────────────────────────────────────
# 会话
# ────────────────────────────────────────────────────────────────
class SqliteSessionRepository(SessionRepository):
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def open_session(self, session: Session) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO sessions "
            "(id, mode, started_at, ended_at, end_reason, total_active_seconds, total_tokens_consumed) "
            "VALUES (?, ?, ?, NULL, NULL, 0, 0)",
            (session.id, session.mode, session.started_at.isoformat(sep=" ", timespec="seconds")),
        )

    def close_session(
        self,
        session_id: str,
        ended_at: datetime,
        end_reason: str,
        total_active_seconds: int,
        total_tokens_consumed: int,
    ) -> None:
        self._conn.execute(
            "UPDATE sessions SET ended_at = ?, end_reason = ?, "
            "total_active_seconds = ?, total_tokens_consumed = ? WHERE id = ?",
            (
                ended_at.isoformat(sep=" ", timespec="seconds"),
                end_reason,
                total_active_seconds,
                total_tokens_consumed,
                session_id,
            ),
        )

    def write_segment(self, segment: AppSegment) -> None:
        self._conn.execute(
            "INSERT INTO app_segments "
            "(session_id, app_identifier, category, rate_multiplier, "
            " active_seconds, idle_seconds, period_start, period_end, tokens_consumed) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                segment.session_id,
                segment.app_identifier,
                segment.category,
                segment.rate_multiplier,
                segment.active_seconds,
                segment.idle_seconds,
                segment.period_start.isoformat(sep=" ", timespec="seconds"),
                segment.period_end.isoformat(sep=" ", timespec="seconds"),
                segment.tokens_consumed,
            ),
        )

    def today_consumption_seconds(self) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(SUM(active_seconds), 0) AS s FROM app_segments "
            "WHERE category = 'consumption' "
            "AND date(period_start, 'localtime') = date('now', 'localtime')"
        ).fetchone()
        return int(row["s"] or 0)

    def pending_segments_for_upload(self, limit: int = 200) -> list[tuple[int, AppSegment]]:
        rows = self._conn.execute(
            "SELECT id, session_id, app_identifier, category, rate_multiplier, "
            " active_seconds, idle_seconds, period_start, period_end, tokens_consumed "
            "FROM app_segments WHERE synced_to_server = 0 "
            "ORDER BY id ASC LIMIT ?",
            (limit,),
        ).fetchall()
        out: list[tuple[int, AppSegment]] = []
        for r in rows:
            try:
                ps = datetime.fromisoformat(r["period_start"])
            except Exception:
                ps = datetime.utcnow()
            try:
                pe = datetime.fromisoformat(r["period_end"])
            except Exception:
                pe = ps
            out.append((
                int(r["id"]),
                AppSegment(
                    session_id=r["session_id"] or "",
                    app_identifier=r["app_identifier"] or "",
                    category=r["category"] or "neutral",
                    rate_multiplier=float(r["rate_multiplier"] or 0.0),
                    active_seconds=int(r["active_seconds"] or 0),
                    idle_seconds=int(r["idle_seconds"] or 0),
                    period_start=ps,
                    period_end=pe,
                    tokens_consumed=int(r["tokens_consumed"] or 0),
                ),
            ))
        return out

    def mark_segments_synced(self, local_ids: list[int]) -> None:
        if not local_ids:
            return
        placeholders = ",".join("?" * len(local_ids))
        self._conn.execute(
            f"UPDATE app_segments SET synced_to_server = 1 WHERE id IN ({placeholders})",
            list(local_ids),
        )


# ────────────────────────────────────────────────────────────────
# 未知 App 队列
# ────────────────────────────────────────────────────────────────
class SqliteUnknownAppQueue(UnknownAppQueue):
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def enqueue(
        self,
        app_identifier: str,
        exe_path: str,
        window_title: str,
        first_seen_at: datetime,
    ) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO unknown_apps_queue "
            "(app_identifier, exe_path, window_title, first_seen_at) "
            "VALUES (?, ?, ?, ?)",
            (
                app_identifier.lower(),
                exe_path,
                window_title,
                first_seen_at.isoformat(sep=" ", timespec="seconds"),
            ),
        )


# ────────────────────────────────────────────────────────────────
# 责任清单
# ────────────────────────────────────────────────────────────────
class SqliteResponsibilityRepository(ResponsibilityRepository):
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def tick(self, task_id: str, on_date: date, completed: bool) -> None:
        self._conn.execute(
            "INSERT INTO responsibility_checks (task_id, check_date, completed) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(task_id, check_date) DO UPDATE SET "
            "  completed = excluded.completed, "
            "  checked_at = CURRENT_TIMESTAMP",
            (task_id, on_date.isoformat(), 1 if completed else 0),
        )

    def get_today(self, today: date) -> dict[str, bool]:
        rows = self._conn.execute(
            "SELECT task_id, completed FROM responsibility_checks WHERE check_date = ?",
            (today.isoformat(),),
        ).fetchall()
        return {r["task_id"]: bool(r["completed"]) for r in rows}
