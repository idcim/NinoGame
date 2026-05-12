"""PIN 验证 + 错误锁定 (§3.2 + §3.3)。

PIN 用 PBKDF2-SHA256 + 16 字节 salt。
连续 3 次错 → 锁 30 分钟。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from comms.event_bus import EventBus
from comms.message_types import Event, EventType
from store.repository import EventSink

_log = logging.getLogger(__name__)

_PBKDF2_ITERATIONS = 240_000
_SALT_BYTES = 16


def _hash(pin: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", pin.encode("utf-8"), salt, _PBKDF2_ITERATIONS
    ).hex()


class PinManager:
    """settings.json 里读 pin_hash / pin_salt。"""

    def __init__(
        self,
        settings_path: str | Path,
        event_sink: EventSink,
        bus: EventBus,
        max_fails: int = 3,
        lockout_minutes: int = 30,
    ) -> None:
        self._path = Path(settings_path)
        self._events = event_sink
        self._bus = bus
        self._max_fails = max_fails
        self._lockout = timedelta(minutes=lockout_minutes)
        self._lock = threading.Lock()
        self._fails: int = 0
        self._locked_until: datetime | None = None

    def is_locked(self) -> bool:
        with self._lock:
            return self._locked_until is not None and datetime.utcnow() < self._locked_until

    def seconds_until_unlock(self) -> int:
        with self._lock:
            if self._locked_until is None:
                return 0
            delta = (self._locked_until - datetime.utcnow()).total_seconds()
            return max(0, int(delta))

    def has_pin(self) -> bool:
        d = self._read_settings()
        return bool(d.get("pin_hash")) and bool(d.get("pin_salt"))

    def set_pin(self, new_pin: str) -> None:
        if not new_pin or len(new_pin) < 4:
            raise ValueError("PIN 至少 4 位")
        salt = secrets.token_bytes(_SALT_BYTES)
        h = _hash(new_pin, salt)
        d = self._read_settings()
        d["pin_hash"] = h
        d["pin_salt"] = salt.hex()
        self._write_settings(d)
        with self._lock:
            self._fails = 0
            self._locked_until = None

    def verify(self, pin: str) -> bool:
        if self.is_locked():
            return False
        d = self._read_settings()
        h = d.get("pin_hash", "")
        salt_hex = d.get("pin_salt", "")
        if not h or not salt_hex:
            return False
        try:
            salt = bytes.fromhex(salt_hex)
        except ValueError:
            return False
        attempt = _hash(pin, salt)
        ok = secrets.compare_digest(attempt, h)
        with self._lock:
            if ok:
                self._fails = 0
                return True
            self._fails += 1
            self._events.emit(Event(
                type=EventType.PIN_FAIL.value,
                payload={"fails": self._fails, "max": self._max_fails},
            ))
            if self._fails >= self._max_fails:
                self._locked_until = datetime.utcnow() + self._lockout
                ev = Event(
                    type=EventType.PIN_LOCKED.value,
                    payload={"locked_until": self._locked_until.isoformat()},
                )
                self._events.emit(ev)
                self._bus.publish(ev)
        return ok

    # ── 私有 ─────────────────────────────────────────────────────
    def _read_settings(self) -> dict:
        if not self._path.exists():
            return {}
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            _log.exception("read settings failed")
            return {}

    def _write_settings(self, d: dict) -> None:
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self._path)
