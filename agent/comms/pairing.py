"""配对核心逻辑 (CLI + GUI 共用)。

提供三件事:
  - parse_magic_link(text): 智能解析剪贴板/输入框内容,
    支持纯 8 位码 / "https://server/#pair=CODE" 链接
  - redeem_pair_code(url, code): POST /api/devices/pair/redeem 拿 token
  - save_pair_settings(settings_path, ...): 写 settings.json

CLI: agent/pair.py 调这个;
GUI: agent/ui/pair_dialog.py 调这个。
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


# ──────────────────────────────────────────────────────────────
# 智能解析
# ──────────────────────────────────────────────────────────────
@dataclass
class ParsedPair:
    server_url: str | None
    code: str | None
    note: str = ""


_PAIR_FRAGMENT = re.compile(r"#pair=([A-Z0-9]{6,16})", re.IGNORECASE)
_CODE_ONLY = re.compile(r"^([A-Z0-9]{6,16})$", re.IGNORECASE)


def parse_magic_link(text: str) -> ParsedPair:
    """支持的输入:
      1) 纯 8 位码: 'ABCDEFGH'
      2) 带 fragment 的链接: 'https://server.com/#pair=ABCDEFGH'
      3) 带 fragment + path: 'https://x.com/pair#pair=ABCDEFGH'
      4) 仅 origin: 'https://server.com' (返回 url, code 为 None)

    返回 ParsedPair。url 总是去掉 trailing /; 没找到 url/code 时对应字段为 None。
    """
    text = text.strip()
    if not text:
        return ParsedPair(None, None, "输入为空")

    # 纯码
    m = _CODE_ONLY.match(text)
    if m:
        return ParsedPair(None, m.group(1).upper(), "仅输入了配对码")

    # 链接
    try:
        parsed = urlparse(text)
    except Exception:
        return ParsedPair(None, None, "无法识别为链接")

    if not parsed.scheme or not parsed.netloc:
        return ParsedPair(None, None, "无法识别为链接")

    server_url = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    code = None

    # fragment 里的 pair=
    if parsed.fragment:
        fm = _PAIR_FRAGMENT.search("#" + parsed.fragment)
        if fm:
            code = fm.group(1).upper()

    # query 里的 pair= (备用)
    if not code and parsed.query:
        for kv in parsed.query.split("&"):
            if kv.lower().startswith("pair="):
                v = kv.split("=", 1)[1].strip().upper()
                if _CODE_ONLY.match(v):
                    code = v
                break

    note = "解析成功" if code else "解析到 URL, 但没找到配对码"
    return ParsedPair(server_url, code, note)


# ──────────────────────────────────────────────────────────────
# HTTP redeem
# ──────────────────────────────────────────────────────────────
def _detect_platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        return "linux"
    return "windows"


def redeem_pair_code(server_url: str, code: str, *, timeout: int = 15) -> dict:
    """调 POST /api/devices/pair/redeem。返回 {agent_token, device_id, child_id}。
    失败抛 RuntimeError(message)。
    """
    url = f"{server_url.rstrip('/')}/api/devices/pair/redeem"
    body = json.dumps({
        "code": code,
        "platform": _detect_platform(),
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        raise RuntimeError(f"HTTP {e.code}: {err_body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"连接失败: {e.reason}") from e


# ──────────────────────────────────────────────────────────────
# settings 写入
# ──────────────────────────────────────────────────────────────
def save_pair_settings(
    settings_path: str | Path,
    server_url: str,
    agent_token: str,
    device_id: str | None,
    child_id: str | None,
) -> None:
    """合并写入 settings.json (保留原有其他键)。"""
    p = Path(settings_path)
    if p.exists():
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
    else:
        d = {}
    d["backend_url"] = server_url
    d["agent_token"] = agent_token
    if device_id:
        d["device_id"] = device_id
    if child_id:
        d["child_id"] = child_id
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
