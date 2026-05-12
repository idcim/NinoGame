"""首次启动用的种子数据。

- config/rules.json: 把 P0 KEYWORDS 翻译成结构化 Rule
- config/app_categories.json: 起步 App 分类种子
- config/tasks.json: 任务模板示例（含责任 checklist）
- config/settings.json: 默认 settings（quota_package=balanced 等）
"""
from __future__ import annotations

import json
from pathlib import Path

from comms.message_types import (
    ActionType,
    AppCategoryName,
    MatcherField,
    MatcherLogic,
    MatcherOp,
)

# 来自 P0 pvz_monitor.py 的关键词集合
PVZ_KEYWORDS = [
    "plantsvszombies",
    "plants vs zombies",
    "plants_vs_zombies",
    "pvz",
    "popcapgame1",
    "植物大战僵尸",
    "pvzhe",
    "pvzrh",
    "pvzcz",
    "zwdzjs",
    "zhiwudazhanjiangshi",
]

PVZ_EXCLUDE_PROCESSES = [
    "obs64.exe", "obs32.exe", "obs.exe",
    "bandicam.exe", "ocam.exe",
    "chrome.exe", "msedge.exe", "firefox.exe",
    "code.exe", "notepad.exe", "explorer.exe",
]


def _matchers_per_field(keywords: list[str]) -> list[dict]:
    fields = [
        MatcherField.PROCESS_NAME.value,
        MatcherField.EXE_PATH.value,
        MatcherField.WINDOW_TITLE.value,
    ]
    out = []
    for kw in keywords:
        for f in fields:
            out.append({"field": f, "op": MatcherOp.ICONTAINS.value, "value": kw})
    return out


def default_rules() -> list[dict]:
    return [
        {
            "id": "rule_pvz_all",
            "name": "PvZ 全家桶",
            "enabled": True,
            "matchers": _matchers_per_field(PVZ_KEYWORDS),
            "matcher_logic": MatcherLogic.OR.value,
            "exclude_processes": PVZ_EXCLUDE_PROCESSES,
            "schedule": {"mode": "always", "windows": []},
            "action": {
                "type": ActionType.KILL_AND_WARN.value,
                "message": "不要想着玩不在我授权的游戏!",
            },
            "category_link": "consumption_game_pvz",
            "notify_parent": True,
        }
    ]


def default_app_categories() -> list[dict]:
    """起步种子。category=consumption 的会在 token_engine 里被扣费；
    productive 的会赚分。"""
    return [
        # —— 消费类（被 PvZ 规则覆盖，会先 kill；保留分类用于以后未被规则盯死的情况）
        {"app_identifier": "plantsvszombies.exe", "category": "consumption",
         "sub_type": "game", "rate_multiplier": 1.5, "source": "seed"},
        {"app_identifier": "popcapgame1.exe", "category": "consumption",
         "sub_type": "game", "rate_multiplier": 1.5, "source": "seed"},

        # —— 中性
        {"app_identifier": "chrome.exe", "category": "neutral",
         "sub_type": "browser", "rate_multiplier": 0.0, "source": "seed"},
        {"app_identifier": "msedge.exe", "category": "neutral",
         "sub_type": "browser", "rate_multiplier": 0.0, "source": "seed"},
        {"app_identifier": "firefox.exe", "category": "neutral",
         "sub_type": "browser", "rate_multiplier": 0.0, "source": "seed"},
        {"app_identifier": "explorer.exe", "category": "neutral",
         "sub_type": "system", "rate_multiplier": 0.0, "source": "seed"},

        # —— 生产类（Path 1 自动赚分）
        {"app_identifier": "code.exe", "category": "productive",
         "sub_type": "create", "rate_multiplier": 1.0, "source": "seed"},
        {"app_identifier": "scratch.exe", "category": "productive",
         "sub_type": "create", "rate_multiplier": 1.0, "source": "seed"},
        {"app_identifier": "kindle.exe", "category": "productive",
         "sub_type": "reading", "rate_multiplier": 1.0, "source": "seed"},

        # —— 短视频 / 视频（孩子常见）
        {"app_identifier": "bilibili.exe", "category": "consumption",
         "sub_type": "video", "rate_multiplier": 1.0, "source": "seed"},
        {"app_identifier": "douyin.exe", "category": "consumption",
         "sub_type": "short_video", "rate_multiplier": 1.5, "source": "seed"},
    ]


def default_tasks() -> list[dict]:
    """模板。category=responsibility 不挣分；incentive 挣分。"""
    return [
        # 责任类（不挣分）
        {"id": "task_clean_desk", "name": "整理书桌",
         "category": "responsibility", "reward_tokens": 0,
         "schedule": "daily", "active": True},
        {"id": "task_take_trash", "name": "倒垃圾",
         "category": "responsibility", "reward_tokens": 0,
         "schedule": "daily", "active": True},
        {"id": "task_make_bed", "name": "自己叠被子",
         "category": "responsibility", "reward_tokens": 0,
         "schedule": "daily", "active": True},

        # 奖励类（P2 才真正走审批；P1 占位）
        {"id": "task_homework", "name": "完成今日作业",
         "category": "incentive", "reward_tokens": 30,
         "schedule": "daily", "verification": "parent_approve", "active": True},
        {"id": "task_reading_30", "name": "阅读 30 分钟",
         "category": "incentive", "reward_tokens": 30,
         "schedule": "daily", "verification": "auto",
         "auto_app_category": "productive", "auto_sub_type": "reading",
         "auto_threshold_minutes": 30, "active": True},
        {"id": "task_practice_instrument", "name": "练琴 30 分钟",
         "category": "incentive", "reward_tokens": 25,
         "schedule": "daily", "verification": "parent_approve", "active": True},
    ]


def default_settings() -> dict:
    return {
        # 成熟度档位（§5）
        "maturity_mode": "negotiable",
        # 配额档位（§6）：balanced 默认
        "quota_package": "balanced",
        "quota_overrides": {
            # 单位都是 token / 分钟。balanced 默认值：
            "weekday_base_tokens": 30,
            "weekend_base_tokens": 90,
            "daily_credit_cap": 120,
            "daily_hard_cap_minutes": 120,
            "high_consumption_rate": 1.5,
        },
        # PIN：P1 占位空字符串，protector/pin_manager 自取
        "pin_hash": "",
        "pin_salt": "",
        # 设备角色（§4）
        "device_type": "child_primary",
        "idle_lock_minutes": 10,
        # 防刷（§16.1 ①）
        "activity_min_event_window_seconds": 60,
        "consumption_active_window_seconds": 120,
        # 监控扫描间隔
        "monitor_scan_interval_seconds": 2,
        # token 计费 tick
        "billing_tick_seconds": 60,
        # 1 token = 1 分钟
        "token_to_minute_ratio": 1.0,

        # ── UI 行为 ──────────────────────────────────────────
        # 警告弹窗自动关闭秒数；0 表示需要手动点击
        "warning_dialog_auto_close_seconds": 0,
        # 玩游戏时的浮层 (§15.3, §22 #17 默认开)
        "overlay_enabled": True,

        # ── 文案模板 (P2 后台可改) ─────────────────────────────
        # 不在这里列出的 key 会回退到 core/messages.py 的 DEFAULTS。
        # 占位符: {balance} {used_minutes} {cap_minutes} {process_name} 等
        "messages": {
            "block_rule_default": "这个应用还没被授权使用哦。可以先做完任务，再和家长商量。",
            "block_daily_cap": (
                "今天的游戏时间已经用完啦。\n"
                "明天再继续吧，剩下的 {balance} token 留着明天用。"
            ),
            "block_out_of_balance": (
                "Token 余额不够支付当前应用的费用。\n"
                "可以做任务挣 token 后再回来。"
            ),
        },
    }


def default_child_profile() -> dict:
    return {
        "username": "nino",
        "display_name": "Nino",
        "birth_year": 2016,
    }


def write_config_files(config_dir: str | Path, overwrite: bool = False) -> None:
    """把所有默认 JSON 写到 config_dir。已存在的文件默认跳过。"""
    config_dir = Path(config_dir)
    config_dir.mkdir(parents=True, exist_ok=True)
    targets = {
        "rules.json": default_rules(),
        "app_categories.json": default_app_categories(),
        "tasks.json": default_tasks(),
        "settings.json": default_settings(),
        "child_profile.json": default_child_profile(),
    }
    for name, data in targets.items():
        p = config_dir / name
        if p.exists() and not overwrite:
            continue
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def seed_app_categories_into_db(repo, categories: list[dict] | None = None) -> None:
    """首次运行把分类种子注入 app_categories 表。"""
    from comms.message_types import AppCategory  # noqa: WPS433 (avoid cycle)

    items = categories if categories is not None else default_app_categories()
    for d in items:
        repo.upsert(AppCategory.from_dict(d))
