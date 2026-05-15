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
_HASH_HEX_LEN = 64  # PBKDF2-SHA256 = 32 bytes = 64 hex chars
_HEX_CHARS = set("0123456789abcdefABCDEF")


def _hash(pin: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", pin.encode("utf-8"), salt, _PBKDF2_ITERATIONS
    ).hex()


def _is_valid_hash_field(value: str) -> bool:
    """判断 pin_hash / pin_salt 字段是不是合法的 hex 字符串。
    pin_hash 必须正好 64 字符；pin_salt 至少 16 字符（8 字节 salt）。"""
    if not value:
        return False
    return all(c in _HEX_CHARS for c in value)


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

        # 启动时检查 pin_hash 字段格式；若是明文（用户直接编辑 JSON 填的）
        # 自动加密保存，避免 verify 永远失败。
        self._auto_migrate_plaintext_pin()

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
        h = d.get("pin_hash", "")
        s = d.get("pin_salt", "")
        # 必须是合法的 hex hash + salt 才算"已设置 PIN"
        return (
            isinstance(h, str)
            and len(h) == _HASH_HEX_LEN
            and _is_valid_hash_field(h)
            and isinstance(s, str)
            and _is_valid_hash_field(s)
        )

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

    def set_pin_raw(self, hash_hex: str, salt_hex: str) -> None:
        """v0.4.3+ 从 server 同步 PIN — 跳过自己 hash, 直接存 server 给的
        hash + salt. 跟 set_pin 同算法 (PBKDF2-SHA256 32B / salt 16B / iter
        240000), server 端 services/parent_pin.ts 已对齐.

        校验 hash_hex 长度 + salt_hex 长度, 防错误 payload 写坏本地.
        """
        if not (
            isinstance(hash_hex, str)
            and len(hash_hex) == _HASH_HEX_LEN
            and _is_valid_hash_field(hash_hex)
        ):
            raise ValueError(f"hash_hex 不合法 (期望 {_HASH_HEX_LEN} hex)")
        if not (
            isinstance(salt_hex, str)
            and len(salt_hex) == _SALT_BYTES * 2
            and _is_valid_hash_field(salt_hex)
        ):
            raise ValueError(f"salt_hex 不合法 (期望 {_SALT_BYTES * 2} hex)")
        d = self._read_settings()
        d["pin_hash"] = hash_hex
        d["pin_salt"] = salt_hex
        self._write_settings(d)
        with self._lock:
            self._fails = 0
            self._locked_until = None

    def clear_pin(self) -> None:
        """v0.4.3+ 清空本地 PIN — 跟 server pin_clear 同步用. 直接清字段
        (跟 clear_pin command 老路径相同). """
        d = self._read_settings()
        d["pin_hash"] = ""
        d["pin_salt"] = ""
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

    # ── 自动迁移 ─────────────────────────────────────────────────
    def _auto_migrate_plaintext_pin(self) -> None:
        """如果 settings.json 里 pin_hash 不是合法的 PBKDF2 hex hash，
        但又非空，按"用户写了明文 PIN"处理：
          - 用它当 plaintext PIN
          - 生成新 salt + 加密
          - 写回 settings.json
        日志不打印明文，只说"已自动迁移"。
        """
        d = self._read_settings()
        h = d.get("pin_hash", "")
        s = d.get("pin_salt", "")
        if not h:
            return
        # 已是合法 hash 就不动
        if (
            isinstance(h, str)
            and len(h) == _HASH_HEX_LEN
            and _is_valid_hash_field(h)
            and isinstance(s, str)
            and _is_valid_hash_field(s)
        ):
            return
        # 否则视为用户直接写了明文 PIN
        plain = str(h)
        if len(plain) < 4:
            _log.warning(
                "settings.json 的 pin_hash 看起来是明文但长度 < 4 (%d 字符), "
                "无法当作 PIN. 已清空; 请运行 set_pin.py 重新设置。",
                len(plain),
            )
            d["pin_hash"] = ""
            d["pin_salt"] = ""
            self._write_settings(d)
            return

        _log.warning(
            "settings.json 的 pin_hash 看起来是明文 PIN (长度=%d). "
            "自动加密保存. 下次启动这条日志不会再出现。",
            len(plain),
        )
        try:
            salt = secrets.token_bytes(_SALT_BYTES)
            new_hash = _hash(plain, salt)
            d["pin_hash"] = new_hash
            d["pin_salt"] = salt.hex()
            self._write_settings(d)
            _log.info("PIN 已用 PBKDF2-SHA256 加密保存到 settings.json")
        except Exception:
            _log.exception("PIN 自动迁移失败")

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
