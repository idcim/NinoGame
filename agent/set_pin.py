"""设置 / 重置家长 PIN。

用法:
    cd G:\\DEL_GAME
    python agent/set_pin.py            # 交互式 (两次输入校验, 屏幕不显示)
    python agent/set_pin.py 1234       # 非交互式 (直接传 PIN, 用于脚本)

会用 PBKDF2-SHA256 + 16 字节随机 salt 加密后写入 config/settings.json
(pin_hash + pin_salt 字段)。

提示：你也可以**直接在 settings.json 写明文 PIN** 到 pin_hash 字段,
Agent 启动时会检测到非 hex 格式自动迁移加密 (PinManager._auto_migrate_plaintext_pin)。
但用本脚本更稳妥，立即生效。
"""
from __future__ import annotations

import getpass
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from comms.event_bus import default_bus  # noqa: E402
from protector.pin_manager import PinManager  # noqa: E402
from store.local_sqlite import SqliteEventSink, open_db  # noqa: E402


def main() -> int:
    settings_path = _HERE / "config" / "settings.json"
    if not settings_path.exists():
        print(f"[error] {settings_path} 不存在；先跑一次 agent 让它生成默认配置。")
        return 1

    # 非交互式：python set_pin.py <pin>
    if len(sys.argv) >= 2:
        new_pin = sys.argv[1].strip()
        if len(new_pin) < 4:
            print("[error] PIN 至少 4 位。")
            return 1
        return _save(settings_path, new_pin)

    # 交互式
    print("=" * 56)
    print(" NinoGame 家长 PIN 设置")
    print("=" * 56)
    print(" PIN 至少 4 位。下面输入时屏幕不显示字符。")
    print()

    pin1 = getpass.getpass("新 PIN: ").strip()
    if len(pin1) < 4:
        print("[error] PIN 至少 4 位。")
        return 1
    pin2 = getpass.getpass("再输一次确认: ").strip()
    if pin1 != pin2:
        print("[error] 两次输入不一致。")
        return 1
    return _save(settings_path, pin1)


def _save(settings_path: Path, new_pin: str) -> int:
    db_path = _HERE / "data" / "ninogame.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = open_db(db_path)
    pm = PinManager(settings_path, SqliteEventSink(conn), default_bus())
    pm.set_pin(new_pin)
    print("[ok] PIN 已设置 (PBKDF2-SHA256 + 16 字节 salt)。")
    print("    下次托盘点"退出"会要求验证此 PIN。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
