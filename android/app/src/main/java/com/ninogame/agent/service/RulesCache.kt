package com.ninogame.agent.service

import android.util.Log
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** 当前生效的规则集合 — 内存 singleton, 不持久化 (hello_ack 总会重新推).
 *
 *  Server 端规则 schema (CLAUDE.md §9.1):
 *    { id, name, enabled, spec: { matchers, matcher_logic, exclude_processes,
 *                                  schedule, action } }
 *
 *  Android 端 simplification: 所有 matcher field (process_name / exe_path /
 *  window_title) 都对 packageName 匹配. 跨端差异由"规则关键词是否真的能命中
 *  package name"决定 — 大多数游戏 / app 规则用 ASCII 关键词 (例 "pvz",
 *  "plantsvszombies", "douyin"), Android pkg 名也是 ASCII, 命中率高. 中文窗口
 *  标题规则在 Android 上很难命中, 这是已知约束, Stage 4 加 platform 字段或
 *  android_package 字段时再优化.
 */
object RulesCache {

    @Serializable
    data class Rule(
        val id: String,
        val name: String,
        val enabled: Boolean = true,
        val spec: RuleSpec,
    )

    @Serializable
    data class RuleSpec(
        val matchers: List<Matcher> = emptyList(),
        val matcher_logic: String = "OR",  // "OR" / "AND"
        val exclude_processes: List<String> = emptyList(),
        val schedule: Schedule = Schedule(),
        val action: Action = Action(),
        val category_link: String? = null,
        val notify_parent: Boolean = true,
    )

    @Serializable
    data class Matcher(
        val field: String,    // process_name / exe_path / window_title / command_line
        val op: String,       // equals / iequals / contains / icontains / regex
        val value: String,
    )

    @Serializable
    data class Schedule(
        val mode: String = "always",   // always / windowed / disabled
        val windows: List<Window> = emptyList(),
    )

    @Serializable
    data class Window(
        val days: List<Int> = emptyList(),  // 0=Sun..6=Sat (JS 习惯)
        val from: String = "",              // "HH:MM"
        val to: String = "",                // "HH:MM"
    )

    @Serializable
    data class Action(
        val type: String = "kill_and_warn", // kill_and_warn / kill_silent / warn_only
        val message: String = "",
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    @Volatile
    private var rules: List<Rule> = emptyList()

    /** 临时解锁 (Stage 3b 加 command 后用). Stage 3a 暂不支持, 留接口. */
    @Volatile
    private var unlockedIds: Set<String> = emptySet()

    @Synchronized
    fun snapshot(): List<Rule> = rules

    @Synchronized
    fun unlockedSnapshot(): Set<String> = unlockedIds

    /** 从 hello_ack.rules / rules_update.rules 的 JsonArray 解析后替换全集. */
    @Synchronized
    fun setFromJsonArray(arr: JsonArray) {
        val parsed = mutableListOf<Rule>()
        for (item in arr) {
            runCatching {
                // server 端 rule 的 spec 可能是 string (jsonb 来的) 或对象; 兼容两种
                val obj = item as? JsonObject ?: return@runCatching
                val spec = obj["spec"]?.let { specEl ->
                    when (specEl) {
                        is JsonObject -> json.decodeFromJsonElement(RuleSpec.serializer(), specEl)
                        else -> json.decodeFromString(RuleSpec.serializer(), specEl.toString())
                    }
                } ?: RuleSpec()
                val rule = Rule(
                    id = obj["id"]?.toString()?.trim('"') ?: return@runCatching,
                    name = obj["name"]?.toString()?.trim('"') ?: "",
                    enabled = (obj["enabled"]?.toString() ?: "true").trim('"').toBoolean(),
                    spec = spec,
                )
                parsed.add(rule)
            }.onFailure { Log.w(TAG, "rule parse failed: $item", it) }
        }
        rules = parsed
        Log.i(TAG, "rules cache updated: ${parsed.size} rules (${parsed.count { it.enabled }} enabled)")
    }

    @Synchronized
    fun setUnlocked(ids: Set<String>) { unlockedIds = ids }

    @Synchronized
    fun reset() {
        rules = emptyList()
        unlockedIds = emptySet()
    }

    private const val TAG = "RulesCache"
}
