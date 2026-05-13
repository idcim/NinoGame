"""ProcessSnapshot × Rule → MatchResult。

纯函数式：输入快照列表 + 规则列表，输出命中列表。
不接触存储、不杀进程、不弹窗——这些是 killer 的事。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, time
from typing import Iterable

from comms.message_types import (
    Matcher,
    MatcherField,
    MatcherLogic,
    MatcherOp,
    MatchResult,
    ProcessSnapshot,
    Rule,
    ScheduleMode,
)

_log = logging.getLogger(__name__)


def _matcher_hits(matcher: Matcher, snap: ProcessSnapshot) -> tuple[bool, str]:
    """单个 matcher 对单个进程的判定。返回 (是否命中, 命中文本片段)。

    exe_path 是按需 lazy 取的: scan_processes 不预填 exe_path 节省 OS 调用,
    匹配到 exe_path field 才查 (复用 monitor.resolve_exe 的缓存)。
    """
    if matcher.field == MatcherField.EXE_PATH.value and not snap.exe_path:
        try:
            from core.monitor import resolve_exe
            snap.exe_path = resolve_exe(snap.pid)
        except Exception:
            snap.exe_path = ""

    target = snap.text_for_field(matcher.field)
    candidates: list[str] = []
    if isinstance(target, list):
        candidates = [t for t in target if t]
    elif target:
        candidates = [target]
    if not candidates:
        return False, ""

    value = matcher.value
    op = matcher.op

    for c in candidates:
        if _single_match(c, value, op):
            return True, c
    return False, ""


def _single_match(text: str, value: str, op: str) -> bool:
    if op == MatcherOp.EQUALS.value:
        return text == value
    if op == MatcherOp.IEQUALS.value:
        return text.lower() == value.lower()
    if op == MatcherOp.CONTAINS.value:
        return value in text
    if op == MatcherOp.ICONTAINS.value:
        return value.lower() in text.lower()
    if op == MatcherOp.REGEX.value:
        try:
            return re.search(value, text) is not None
        except re.error:
            _log.warning("invalid regex matcher value: %r", value)
            return False
    return False


def _parse_hhmm(s: str) -> time | None:
    """'21:00' / '7:5' → time。无效返回 None。"""
    if not s or not isinstance(s, str):
        return None
    try:
        h_str, m_str = s.split(":", 1)
        h, m = int(h_str), int(m_str)
        if 0 <= h < 24 and 0 <= m < 60:
            return time(hour=h, minute=m)
    except (ValueError, TypeError):
        pass
    return None


def _window_matches_now(window: dict, now: datetime) -> bool:
    """单个时间窗判定: 当前 weekday ∈ days 且 当前时间 ∈ [from, to)。

    weekday 用 JS 习惯 0=周日..6=周六 (与前端 Date.getDay 一致),
    Python 默认 monday=0 sunday=6, 用 (weekday + 1) % 7 转换。
    to < from 表示跨午夜 (例如 "21:00"→"02:00"); 把窗口拆成"今日 from..23:59"
    和"次日 00:00..to" 两段, 用 OR 命中。
    """
    days = window.get("days") or []
    if days:
        js_weekday = (now.weekday() + 1) % 7  # python mon=0 → js sun=0
        if js_weekday not in days:
            # 跨午夜情况: 如果"昨天"weekday 在 days 里, 且当前时间 < to, 也算命中
            t = _parse_hhmm(window.get("from", ""))
            t_to = _parse_hhmm(window.get("to", ""))
            if t and t_to and t_to < t:
                yesterday_weekday = (js_weekday - 1) % 7
                if yesterday_weekday in days and now.time() < t_to:
                    return True
            return False

    t_from = _parse_hhmm(window.get("from", ""))
    t_to = _parse_hhmm(window.get("to", ""))
    if t_from is None or t_to is None:
        return False
    now_t = now.time()
    if t_to == t_from:
        return False  # 退化, 0 长度
    if t_to > t_from:
        return t_from <= now_t < t_to
    # 跨午夜: 命中区间 = [from, 24:00) ∪ [00:00, to)
    return now_t >= t_from or now_t < t_to


def _schedule_allows(rule: Rule) -> bool:
    """always / windowed / disabled。

    windowed: rule.schedule.windows 任一窗口命中即允许; windows 空保守视为 always。
    """
    sched = rule.schedule
    mode = sched.mode if sched else ScheduleMode.ALWAYS.value
    if mode == ScheduleMode.DISABLED.value:
        return False
    if mode == ScheduleMode.WINDOWED.value:
        windows = sched.windows or []
        if not windows:
            return True  # 没配窗口, 不当作 "永远不允许"
        now = datetime.now()
        for w in windows:
            if not isinstance(w, dict):
                continue
            if _window_matches_now(w, now):
                return True
        return False
    return True


def _is_excluded(snap: ProcessSnapshot, exclude: list[str]) -> bool:
    if not exclude:
        return False
    name_lc = snap.name.lower()
    return any(name_lc == e.lower() for e in exclude)


def evaluate(
    snapshots: Iterable[ProcessSnapshot],
    rules: Iterable[Rule],
    unlocked_rule_ids: set[str] | None = None,
) -> list[MatchResult]:
    """对每个 snapshot 评估所有规则，返回所有命中。

    unlocked_rule_ids: 当前处于临时解锁状态的规则 ID 集合 (家长批准的
    temporary_unlock 期间, 跳过这些规则; token 扣费仍照常进行)。
    同一进程命中多条规则会返回多个 MatchResult（killer 去重）。
    """
    snapshots_list = list(snapshots)
    out: list[MatchResult] = []
    unlocked = unlocked_rule_ids or set()
    for rule in rules:
        if not rule.enabled:
            continue
        if rule.id in unlocked:
            continue  # 解锁窗口内, 该规则暂停拦截
        if not _schedule_allows(rule):
            continue
        logic = rule.matcher_logic or MatcherLogic.OR.value
        for snap in snapshots_list:
            if _is_excluded(snap, rule.exclude_processes):
                continue
            hit, reason = _evaluate_rule_against(rule, snap, logic)
            if hit:
                out.append(MatchResult(rule=rule, process=snap, reason=reason))
    return out


def _evaluate_rule_against(
    rule: Rule,
    snap: ProcessSnapshot,
    logic: str,
) -> tuple[bool, str]:
    if not rule.matchers:
        return False, ""

    if logic == MatcherLogic.OR.value:
        for m in rule.matchers:
            ok, txt = _matcher_hits(m, snap)
            if ok:
                return True, f"{m.field} {m.op} {m.value!r} → {txt!r}"
        return False, ""

    # AND
    last_txt = ""
    for m in rule.matchers:
        ok, txt = _matcher_hits(m, snap)
        if not ok:
            return False, ""
        last_txt = txt
    return True, f"AND-all matchers hit (last: {last_txt!r})"
