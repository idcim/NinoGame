"""设置 / 重置家长 PIN。

用法:
    cd G:\\DEL_GAME
    python agent/set_pin.py

会要求输入两次新 PIN，验证一致后写入 config/settings.json
(pin_hash + pin_salt, PBKDF2-SHA256 加盐)。

如果忘了 PIN: 把 settings.json 里 pin_hash / pin_salt 清空,
然后再跑这个脚本设置新 PIN。
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

    db_path = _HERE / "data" / "ninogame.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = open_db(db_path)
    pm = PinManager(settings_path, SqliteEventSink(conn), default_bus())
    pm.set_pin(pin1)
    print()
    print("[ok] PIN 已设置。下次托盘点"退出"会要求验证此 PIN。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
