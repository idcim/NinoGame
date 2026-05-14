package com.ninogame.agent.service

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** 当前生效的任务模板 — 跟 RulesCache 一样的"server-driven 内存 cache".
 *
 *  来源: hello_ack.tasks (重连一次性下发) + tasks_update push (家长后台改任务即时推).
 *
 *  Schema 跟 server backend/src/routes/tasks.ts TaskRow 一致:
 *    {id, child_id, name, category, reward_tokens, daily_max_completions,
 *     verification, schedule, active}
 *
 *  category:
 *    - "responsibility" 责任清单 (不挣分, §8.6) — UI 走 checkbox + checklist_tick event
 *    - "incentive" 激励任务 (挣 token, §8.3) — UI 走"申报"按钮 + task_claim message
 *
 *  active=false 的不会被 server 推; Agent 端不再过滤.
 */
object TasksCache {

    @Serializable
    data class Task(
        val id: String,
        val name: String,
        val category: String,
        val reward_tokens: Int = 0,
        val daily_max_completions: Int = 1,
        val verification: String = "parent_approve",
        val schedule: String = "daily",
        val active: Boolean = true,
    )

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val _tasks = MutableStateFlow<List<Task>>(emptyList())
    val tasks: StateFlow<List<Task>> = _tasks.asStateFlow()

    /** 接受 hello_ack.tasks / tasks_update.tasks 的 JsonArray, 替换全集. */
    fun setFromJsonArray(arr: JsonArray) {
        val parsed = mutableListOf<Task>()
        for (item in arr) {
            runCatching {
                val obj = item as? JsonObject ?: return@runCatching
                val task = json.decodeFromJsonElement(Task.serializer(), obj)
                parsed.add(task)
            }.onFailure { Log.w(TAG, "task parse failed: $item", it) }
        }
        _tasks.value = parsed
        Log.i(
            TAG,
            "tasks cache updated: ${parsed.size} (${parsed.count { it.category == "responsibility" }} responsibility, ${parsed.count { it.category == "incentive" }} incentive)",
        )
    }

    fun reset() {
        _tasks.value = emptyList()
    }

    private const val TAG = "TasksCache"
}
