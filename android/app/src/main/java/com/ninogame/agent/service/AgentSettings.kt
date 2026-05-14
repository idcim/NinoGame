package com.ninogame.agent.service

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/** 当前生效的孩子 settings — 由 server 在 hello_ack.settings 携带或 settings_update 推送.
 *
 *  来源: backend/src/services/child_settings.ts DEFAULT_SETTINGS 字段白名单. Android
 *  只用其中跟自己有关的几个 (idle_lock_minutes / billing_tick_seconds /
 *  token_to_minute_ratio / request_quick_options), 其它字段忽略 (overlay/jiggler/...
 *  都是 Windows-specific).
 *
 *  作用方:
 *    - TokenTicker: 每 tick 读 amountPerTick + intervalSeconds
 *    - ScreenStateReceiver: 起 idle-lock 定时器读 idleLockMinutes
 *    - RequestDialog: 顶部 chips 渲染 requestQuickOptions
 */
object AgentSettings {

    data class Snapshot(
        val idleLockMinutes: Long = 10L,
        val billingTickSeconds: Long = 60L,
        val tokenToMinuteRatio: Double = 1.0,
        val requestQuickOptions: List<String> = DEFAULT_QUICK_OPTIONS,
    )

    private val DEFAULT_QUICK_OPTIONS = listOf(
        "作业写完了, 想玩 30 分钟",
        "想看一集动画片",
        "想玩 30 分钟游戏",
        "想跟朋友联机玩",
        "想休息一下放松",
    )

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state.asStateFlow()

    fun current(): Snapshot = _state.value

    /** server 发来的 settings JSON, 解析 + merge 入当前 state (未发的字段保持原值). */
    fun applyFromServer(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val cur = _state.value
        val next = cur.copy(
            idleLockMinutes = obj["idle_lock_minutes"]?.jsonPrimitive?.intOrNull?.toLong()
                ?: cur.idleLockMinutes,
            billingTickSeconds = obj["billing_tick_seconds"]?.jsonPrimitive?.intOrNull?.toLong()
                ?: cur.billingTickSeconds,
            tokenToMinuteRatio = obj["token_to_minute_ratio"]?.jsonPrimitive?.doubleOrNull
                ?: cur.tokenToMinuteRatio,
            requestQuickOptions = parseQuickOptions(obj["request_quick_options"]) ?: cur.requestQuickOptions,
        )
        if (next != cur) {
            _state.value = next
            Log.i(
                TAG,
                "settings applied: idle=${next.idleLockMinutes}min tick=${next.billingTickSeconds}s ratio=${next.tokenToMinuteRatio} quick_opts=${next.requestQuickOptions.size}",
            )
        }
    }

    private fun parseQuickOptions(el: JsonElement?): List<String>? {
        val arr = (el as? JsonArray) ?: return null
        val out = mutableListOf<String>()
        for (item in arr) {
            item.jsonPrimitive.contentOrNull?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        }
        // 空数组也认 — 家长清空 quick options 可能就是想关掉
        return out
    }

    fun reset() {
        _state.value = Snapshot()
    }

    private const val TAG = "AgentSettings"
}
