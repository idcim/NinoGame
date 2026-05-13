"""Agent 端配对 CLI: 兑换家长后台的 8 位配对码 → agent_token → 写 settings.json。

用法:
    cd G:\\DEL_GAME
    python agent/pair.py                                # 交互式
    python agent/pair.py http://127.0.0.1:8088 ABCD2345  # url + code 两段式
    python agent/pair.py "https://x.com/#pair=ABCD2345"  # 一段式 (魔法链接)

也可以从家长后台 GUI 「设置 → 重新配对」直接走 Qt 对话框, 见 ui/pair_dialog.py。
"""
from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from comms.pairing import parse_magic_link, redeem_pair_code, save_pair_settings  # noqa: E402


def main() -> int:
    settings_path = _HERE / "config" / "settings.json"
    args = sys.argv[1:]

    server_url: str | None = None
    code: str | None = None

    if len(args) == 1:
        # 一段式: 魔法链接 (含 #pair=CODE)
        pp = parse_magic_link(args[0])
        server_url, code = pp.server_url, pp.code
    elif len(args) >= 2:
        server_url = args[0].rstrip("/")
        # 第二参数允许是纯码或链接片段
        pp = parse_magic_link(args[1])
        code = pp.code or args[1].strip().upper()
    else:
        # 交互式
        print("=" * 56)
        print(" NinoGame Agent 配对")
        print("=" * 56)
        print(" 粘贴家长后台「生成配对码」给的链接, 或分别输入 URL + 码")
        print()
        first = input("链接 (或直接输入 URL): ").strip()
        pp = parse_magic_link(first)
        server_url, code = pp.server_url, pp.code
        if not code:
            code = input("配对码 (8 位): ").strip().upper()
        if not server_url:
            server_url = input("Backend URL (例 http://127.0.0.1:8088): ").strip().rstrip("/")

    if not server_url or not code:
        print(f"[error] URL / 码 解析失败 (url={server_url!r}, code={code!r})")
        return 1
    if len(code) < 6:
        print(f"[error] 码长度不对: {len(code)} 位")
        return 1

    url = f"{server_url}/api/devices/pair/redeem"
    print(f"[pair] POST {url}  code={code}")
    try:
        result = redeem_pair_code(server_url, code)
    except RuntimeError as e:
        print(f"[error] 兑换失败: {e}")
        return 1

    token = result.get("agent_token")
    device_id = result.get("device_id")
    child_id = result.get("child_id")
    if not token:
        print(f"[error] 后端返回缺 agent_token: {result}")
        return 1

    save_pair_settings(settings_path, server_url, token, device_id, child_id)
    print("[ok] 配对成功; settings.json 已更新")
    print(f"     server    = {server_url}")
    print(f"     device_id = {device_id}")
    print(f"     child_id  = {child_id}")
    print(f"     token     = {token[:8]}... (已存)")
    print()
    print("启动 / 重启 NinoGameAgent.exe 即开始走 WebSocketTransport")
    return 0


if __name__ == "__main__":
    sys.exit(main())
