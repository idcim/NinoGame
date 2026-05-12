"""所有面向用户的文案集中管理。

P1 从 settings.json 的 `messages` 节读，缺省回退到 DEFAULTS。
P2 后台改 settings.json 即可实时生效（reload() 重读）。

支持 {balance} {minutes} 等占位，调用方 get(key, balance=12) 替换。
未提供的占位保留原样，不抛异常。
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

_log = logging.getLogger(__name__)


class _SafeDict(dict):
    """str.format_map 用，缺失 key 时保留 {key} 原样而不抛 KeyError。"""

    def __missing__(self, key):
        return "{" + key + "}"


class Messages:
    """文案中心。线程安全的轻量缓存。"""

    DEFAULTS: dict[str, str] = {
        # ── 拦截弹窗 ──────────────────────────────────────────────
        "block_dialog_title": "NinoGame · 提醒",
        "block_dialog_button": "我知道了",

        # 规则命中（rule.action.message 为空时回退）
        "block_rule_default": "这个应用没有被授权使用。请先和家长沟通。",

        # 每日时间硬上限
        "block_daily_cap": (
            "今天的游戏时间已经用完啦。\n"
            "明天再继续吧，剩下的 {balance} token 留着明天用。"
        ),

        # 余额不足
        "block_out_of_balance": (
            "Token 余额不够支付当前应用的费用。\n"
            "可以做任务挣 token 后再回来。"
        ),

        # ── 退出确认 ──────────────────────────────────────────────
        "quit_dialog_title": "退出 NinoGame",
        "quit_button_confirm": "确认退出",
        "quit_button_cancel": "取消",

        # 没设置 PIN 时
        "quit_confirm_no_pin": (
            "确定要退出 NinoGame 吗?\n"
            "退出后所有监控规则将停止生效。\n\n"
            "建议先在 config/settings.json 里设置家长 PIN，"
            "之后退出会需要家长确认。"
        ),

        # 设置了 PIN 时
        "quit_prompt_pin": "请输入家长 PIN 才能退出监控。",
        "quit_pin_wrong": "PIN 错误。再试 {remaining} 次后将锁定。",
        "quit_pin_locked": "PIN 已锁定，请 {minutes} 分钟后再试。",

        # ── 模式切换 ──────────────────────────────────────────────
        "idle_lock_notice": "已离开 10 分钟，自动进入锁定模式。",
        "mode_switched_to_child": "已进入 Child 模式，开始计费。",
        "mode_switched_to_lock": "已锁定。",

        # ── 系统状态 ──────────────────────────────────────────────
        "tray_tooltip": "NinoGame · {mode} · {balance} token",

        # ── 远程命令到达提示 (家长后台/curl push 时孩子端看到) ────
        "cmd_temporary_unlock_title": "家长放行通知",
        "cmd_temporary_unlock_body": (
            "家长放行了 {rule_name}, 你可以玩 {minutes} 分钟。\n"
            "期间 token 按使用时间扣费。"
        ),
        "cmd_lock_device_title": "设备已锁定",
        "cmd_lock_device_body": "设备被远程锁定。",
        "cmd_start_free_pass_title": "限免活动",
        "cmd_start_free_pass_body": "限免开始: {minutes} 分钟内不扣 token。",
        "cmd_end_free_pass_title": "限免结束",
        "cmd_end_free_pass_body": "限免结束, 恢复正常计费。",

        # ── 解锁到期 / 浮层 ─────────────────────────────────────
        "unlock_expired_title": "时间到了",
        "unlock_expired_body": "之前的放行到期, 游戏恢复拦截。",
        "overlay_unlock_label": "已放行",
    }

    def __init__(self, settings_path: str | Path) -> None:
        self._path = Path(settings_path)
        self._lock = threading.Lock()
        self._cache: dict[str, str] = dict(self.DEFAULTS)
        self.reload()

    def reload(self) -> None:
        """从 settings.json 的 messages 节读覆盖；缺的用 DEFAULTS。"""
        with self._lock:
            self._cache = dict(self.DEFAULTS)
            if not self._path.exists():
                return
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                _log.exception("读取 settings.json 失败，文案用默认值")
                return
            user_msgs = data.get("messages", {})
            if isinstance(user_msgs, dict):
                for k, v in user_msgs.items():
                    if isinstance(v, str):
                        self._cache[k] = v

    def get(self, key: str, **subs) -> str:
        with self._lock:
            tmpl = self._cache.get(key, self.DEFAULTS.get(key, key))
        if not subs:
            return tmpl
        try:
            return tmpl.format_map(_SafeDict(**subs))
        except Exception:
            _log.exception("格式化文案 key=%s 失败", key)
            return tmpl

    def all_keys(self) -> list[str]:
        with self._lock:
            return sorted(set(self._cache) | set(self.DEFAULTS))
