package com.ninogame.agent.service

import android.util.Log
import java.util.Calendar
import java.util.Locale

/** 规则匹配引擎 — 移植自 Windows agent core/rule_engine.py.
 *
 *  Android 端 simplification: 所有 matcher.field 都对 packageName 匹配 (没有
 *  exe_path / window_title 概念, AccessibilityEvent.text 不可靠). 见 [RulesCache]
 *  注释里的跨端策略.
 */
object RuleEngine {

    data class Hit(
        val rule: RulesCache.Rule,
        val matchedValue: String,
    )

    /** 对单个 pkg 跑全部规则 — 返回所有命中的规则 (可能多条).
     *  注: free_pass 期间规则**仍然生效** (CLAUDE.md §7.5: 限免活动期间消费类
     *  应用照拦, 只是 token 不扣). 跟 Windows agent 一致, RuleEngine 不看 free_pass. */
    fun match(packageName: String): List<Hit> {
        if (packageName.isBlank()) return emptyList()
        val rules = RulesCache.snapshot()
        val unlocked = RulesCache.unlockedSnapshot()
        val hits = mutableListOf<Hit>()
        for (rule in rules) {
            if (!rule.enabled) continue
            if (rule.id in unlocked) continue
            if (rule.spec.schedule.mode == "disabled") continue
            if (!scheduleAllows(rule.spec.schedule)) continue
            if (isExcluded(packageName, rule.spec.exclude_processes)) continue
            if (evaluateMatchers(packageName, rule.spec)) {
                hits.add(Hit(rule, packageName))
            }
        }
        return hits
    }

    // ── matchers ──────────────────────────────────────────────────

    private fun evaluateMatchers(pkg: String, spec: RulesCache.RuleSpec): Boolean {
        if (spec.matchers.isEmpty()) return false
        return when (spec.matcher_logic.uppercase(Locale.US)) {
            "AND" -> spec.matchers.all { matcherHits(pkg, it) }
            else -> spec.matchers.any { matcherHits(pkg, it) } // OR (默认)
        }
    }

    private fun matcherHits(pkg: String, m: RulesCache.Matcher): Boolean {
        // Android 端: 不管 field 是什么 (process_name / exe_path / window_title),
        // 全用 packageName 当唯一候选字符串
        return singleMatch(pkg, m.value, m.op)
    }

    private fun singleMatch(text: String, value: String, op: String): Boolean {
        return when (op) {
            "equals" -> text == value
            "iequals" -> text.equals(value, ignoreCase = true)
            "contains" -> text.contains(value)
            "icontains" -> text.contains(value, ignoreCase = true)
            "regex" -> runCatching { Regex(value).containsMatchIn(text) }
                .onFailure { Log.w(TAG, "invalid regex: $value", it) }
                .getOrDefault(false)
            else -> false
        }
    }

    private fun isExcluded(pkg: String, excludes: List<String>): Boolean {
        for (e in excludes) {
            if (e.equals(pkg, ignoreCase = true)) return true
        }
        return false
    }

    // ── schedule.windows 时间窗 ───────────────────────────────────

    private fun scheduleAllows(schedule: RulesCache.Schedule): Boolean {
        return when (schedule.mode) {
            "always" -> true
            "disabled" -> false
            "windowed" -> {
                val now = Calendar.getInstance()
                if (schedule.windows.isEmpty()) true
                else schedule.windows.any { windowMatchesNow(it, now) }
            }
            else -> true
        }
    }

    /** 单个时间窗判定 — 跟 Windows agent 同语义.
     *  days 用 JS 习惯 0=Sun..6=Sat. Java Calendar.DAY_OF_WEEK 是 1=Sun..7=Sat,
     *  减 1 转 JS. 跨午夜 (to < from) 支持: 把窗口拆 "今日 from..23:59" + "次日 00:00..to". */
    private fun windowMatchesNow(window: RulesCache.Window, now: Calendar): Boolean {
        val tFrom = parseHHMM(window.from) ?: return false
        val tTo = parseHHMM(window.to) ?: return false
        val crossesMidnight = tTo < tFrom
        val jsWeekday = (now.get(Calendar.DAY_OF_WEEK) - 1).coerceIn(0, 6)

        val nowMin = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val fromMin = tFrom.hour * 60 + tFrom.minute
        val toMin = tTo.hour * 60 + tTo.minute

        if (window.days.isNotEmpty()) {
            if (jsWeekday in window.days) {
                if (crossesMidnight) {
                    // 命中"今日"部分: from..23:59
                    if (nowMin >= fromMin) return true
                } else {
                    if (nowMin in fromMin until toMin) return true
                }
            }
            // 跨午夜 + 当前不是 days 集中的日子: 检查"昨日是否在 days" + 当前时间 < to
            if (crossesMidnight) {
                val yesterdayWeekday = ((jsWeekday - 1) + 7) % 7
                if (yesterdayWeekday in window.days && nowMin < toMin) return true
            }
            return false
        }
        // 无 days 限制 = 每天该窗口
        return if (crossesMidnight) {
            nowMin >= fromMin || nowMin < toMin
        } else {
            nowMin in fromMin until toMin
        }
    }

    private data class HHMM(val hour: Int, val minute: Int)

    private fun parseHHMM(s: String): HHMM? {
        if (s.isBlank()) return null
        return runCatching {
            val parts = s.split(":")
            val h = parts[0].toInt()
            val m = parts[1].toInt()
            if (h !in 0..23 || m !in 0..59) null
            else HHMM(h, m)
        }.getOrNull()
    }

    private const val TAG = "RuleEngine"
}
