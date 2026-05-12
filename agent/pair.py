"""Agent 端配对脚本: 把家长后台生成的 8 位配对码兑换成 agent_token, 写进 settings.json。

用法:
    cd G:\\DEL_GAME
    python agent/pair.py                      # 交互式 (问 URL + 码)
    python agent/pair.py http://127.0.0.1:8088 ABCDEFGH    # 一行

流程:
  1. 家长在后台 (POST /api/devices/pair) 生成 8 位码 (30 分钟有效)
  2. 在 Agent 设备跑本脚本输入码
  3. 脚本调 POST /api/devices/pair/redeem → 拿 agent_token
  4. 写入 config/settings.json:
       backend_url:  http://...:8088
       agent_token:  <token>
       device_id:    <uuid>
       child_id:     <uuid>
  5. 下次启动 Agent 自动用 WebSocketTransport 连后端
"""
from __future__ import annotations

import getpass
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SETTINGS = _HERE / "config" / "settings.json"


def _post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e


def _save_settings(updates: dict) -> None:
    if _SETTINGS.exists():
        with open(_SETTINGS, "r", encoding="utf-8") as f:
            d = json.load(f)
    else:
        d = {}
    d.update(updates)
    with open(_SETTINGS, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def _detect_platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        return "linux"
    return "windows"


def main() -> int:
    args = sys.argv[1:]
    if len(args) >= 2:
        backend_url, code = args[0].rstrip("/"), args[1].strip().upper()
    else:
        print("=" * 56)
        print(" NinoGame Agent 配对")
        print("=" * 56)
        print()
        backend_url = input("后端 URL (例如 http://127.0.0.1:8088): ").strip().rstrip("/")
        code = input("配对码 (8 位, 家长后台生成): ").strip().upper()

    if not backend_url or not code:
        print("[error] URL / 码不能为空")
        return 1
    if len(code) != 8:
        print(f"[error] 码长度应该是 8 位, 你输的是 {len(code)} 位")
        return 1

    url = f"{backend_url}/api/devices/pair/redeem"
    print(f"[pair] POST {url}")
    try:
        result = _post_json(url, {
            "code": code,
            "platform": _detect_platform(),
        })
    except Exception as e:
        print(f"[error] 兑换失败: {e}")
        return 1

    token = result.get("agent_token")
    device_id = result.get("device_id")
    child_id = result.get("child_id")
    if not token:
        print(f"[error] 后端返回缺 agent_token: {result}")
        return 1

    _save_settings({
        "backend_url": backend_url,
        "agent_token": token,
        "device_id": device_id,
        "child_id": child_id,
    })

    print("[ok] 配对成功; settings.json 已更新")
    print(f"     device_id = {device_id}")
    print(f"     child_id  = {child_id}")
    print(f"     token     = {token[:8]}... (已存)")
    print()
    print("启动 / 重启 NinoGameAgent.exe 即开始走 WebSocketTransport")
    return 0


if __name__ == "__main__":
    sys.exit(main())
