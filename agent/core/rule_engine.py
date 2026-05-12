"""ProcessSnapshot × Rule → MatchResult。

纯函数式：输入快照列表 + 规则列表，输出命中列表。
不接触存储、不杀进程、不弹窗——这些是 killer 的事。
"""
from __future__ import annotations

import logging
import re
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


def _schedule_allows(rule: Rule) -> bool:
    """P1 只支持 always / disabled。windowed 留给 P3+。"""
    mode = rule.schedule.mode if rule.schedule else ScheduleMode.ALWAYS.value
    if mode == ScheduleMode.DISABLED.value:
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
