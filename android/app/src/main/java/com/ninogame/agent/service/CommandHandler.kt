package com.ninogame.agent.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.ninogame.agent.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/** 处理 server 推过来的 command (跟 Windows agent main.py._handle_command 同语义).
 *
 *  CLAUDE.md §19.5 命令清单:
 *    - temporary_unlock {rule_ids|rule_id, duration_seconds|duration_minutes}
 *      → RulesCache.unlockedIds 加 rule_id, 定时器到期清掉
 *    - lock_device {} → 切 mode=Lock (Android 没法强制锁屏, 仅记标志 + 通知)
 *    - start_free_pass {duration_minutes} → AgentState.freePassUntilMs
 *    - end_free_pass {} → 清 freePassUntilMs
 *    - set_pin / clear_pin → Stage 3c 加孩子端 PIN 时再实施
 *    - update_self → Android 走独立 APK 升级链路, Stage 4+ 加
 *    - request_status → Stage 3c 加
 */
class CommandHandler(
    private val scope: CoroutineScope,
    private val context: Context,
) {
    private val unlockExpiryJobs = mutableMapOf<String, Job>()
    private var freePassJob: Job? = null

    /** 入口 — AgentService.handleMessage 调; 也处理 hello_ack.pending_commands. */
    fun handle(commandType: String?, payload: JsonElement?, commandId: String? = null) {
        val type = commandType ?: return
        Log.i(TAG, "handle command type=$type id=$commandId")
        val obj = (payload as? JsonObject)
        when (type) {
            "temporary_unlock" -> handleTemporaryUnlock(obj)
            "lock_device" -> handleLockDevice()
            "start_free_pass" -> handleStartFreePass(obj)
            "end_free_pass" -> handleEndFreePass()
            "set_pin" -> handleSetPin(obj)
            "clear_pin" -> handleClearPin()
            "request_status", "update_self" -> {
                Log.d(TAG, "command $type not implemented (Android-side TBD), ignored")
            }
            else -> Log.w(TAG, "unknown command type: $type")
        }
    }

    /** hello_ack.pending_commands 在重连后回放. server 发来的形态:
     *    [{ id, command_type, payload }] */
    fun handlePending(pending: JsonArray?) {
        if (pending == null) return
        for (item in pending) {
            val obj = (item as? JsonObject) ?: continue
            val cmdType = obj["command_type"]?.jsonPrimitive?.contentOrNull
            val cmdId = obj["id"]?.jsonPrimitive?.contentOrNull
            val pl = obj["payload"]
            handle(cmdType, pl, cmdId)
        }
    }

    // ── temporary_unlock ──────────────────────────────────────────

    private fun handleTemporaryUnlock(payload: JsonObject?) {
        if (payload == null) return
        // 支持 rule_ids (数组) + rule_id (单数兼容). server v0.4+ 优先发数组.
        val ruleIds = mutableListOf<String>()
        runCatching {
            payload["rule_ids"]?.jsonArray?.forEach { el ->
                el.jsonPrimitive.contentOrNull?.let { ruleIds.add(it) }
            }
        }
        if (ruleIds.isEmpty()) {
            payload["rule_id"]?.jsonPrimitive?.contentOrNull?.let { ruleIds.add(it) }
        }
        if (ruleIds.isEmpty()) {
            Log.w(TAG, "temporary_unlock 缺 rule_ids/rule_id")
            return
        }
        val secs = payload["duration_seconds"]?.jsonPrimitive?.intOrNull ?: 0
        val mins = payload["duration_minutes"]?.jsonPrimitive?.intOrNull ?: 0
        val durationSec = if (secs > 0) secs else mins * 60
        if (durationSec <= 0) {
            Log.w(TAG, "temporary_unlock 缺 duration")
            return
        }
        // 合并到 unlockedIds; 各自起一个 expiry 协程
        val cur = RulesCache.unlockedSnapshot().toMutableSet()
        cur.addAll(ruleIds)
        RulesCache.setUnlocked(cur)
        Log.i(TAG, "★ unlock ${ruleIds.size} rules for ${durationSec}s: $ruleIds")
        for (rid in ruleIds) {
            unlockExpiryJobs[rid]?.cancel()
            unlockExpiryJobs[rid] = scope.launch {
                delay(durationSec * 1000L)
                if (!isActive) return@launch
                val next = RulesCache.unlockedSnapshot().toMutableSet()
                next.remove(rid)
                RulesCache.setUnlocked(next)
                unlockExpiryJobs.remove(rid)
                Log.i(TAG, "unlock expired for $rid")
            }
        }
        // 通知
        val minDisplay = (durationSec / 60).coerceAtLeast(1)
        notifyAgent(
            channel = CMD_CHANNEL,
            title = context.getString(R.string.cmd_unlock_title),
            body = context.getString(R.string.cmd_unlock_body, ruleIds.size, minDisplay),
            id = NID_UNLOCK,
            logKind = NotifLog.Kind.UNLOCK,
        )
    }

    // ── lock_device ───────────────────────────────────────────────

    private fun handleLockDevice() {
        AgentState.setMode(AgentState.Mode.Lock)
        Log.i(TAG, "★ mode → Lock (家长锁屏命令)")
        notifyAgent(
            channel = CMD_CHANNEL,
            title = context.getString(R.string.cmd_lock_title),
            body = context.getString(R.string.cmd_lock_body),
            id = NID_LOCK,
            logKind = NotifLog.Kind.LOCK,
        )
    }

    // ── free_pass ─────────────────────────────────────────────────

    private fun handleStartFreePass(payload: JsonObject?) {
        val mins = payload?.get("duration_minutes")?.jsonPrimitive?.intOrNull ?: 0
        if (mins <= 0) {
            Log.w(TAG, "start_free_pass 缺 duration_minutes")
            return
        }
        val expiresAt = System.currentTimeMillis() + mins * 60_000L
        AgentState.setFreePassUntil(expiresAt)
        Log.i(TAG, "★ free_pass for $mins min, until ${expiresAt}")
        freePassJob?.cancel()
        freePassJob = scope.launch {
            delay(mins * 60_000L)
            if (!isActive) return@launch
            // 双重判定: 防中间 end_free_pass 已经清了 + 又来一次 start 的边界
            if (AgentState.freePassUntilMs.value == expiresAt) {
                AgentState.setFreePassUntil(null)
                Log.i(TAG, "free_pass auto-expired")
                notifyAgent(
                    channel = CMD_CHANNEL,
                    title = context.getString(R.string.cmd_free_pass_end_title),
                    body = context.getString(R.string.cmd_free_pass_end_body),
                    id = NID_FREE_PASS,
                    logKind = NotifLog.Kind.FREE_PASS,
                )
            }
        }
        notifyAgent(
            channel = CMD_CHANNEL,
            title = context.getString(R.string.cmd_free_pass_start_title),
            body = context.getString(R.string.cmd_free_pass_start_body, mins),
            id = NID_FREE_PASS,
            logKind = NotifLog.Kind.FREE_PASS,
        )
    }

    private fun handleEndFreePass() {
        val wasActive = AgentState.freePassUntilMs.value != null
        AgentState.setFreePassUntil(null)
        freePassJob?.cancel()
        freePassJob = null
        Log.i(TAG, "★ free_pass ended manually (was_active=$wasActive)")
        if (wasActive) {
            notifyAgent(
                channel = CMD_CHANNEL,
                title = context.getString(R.string.cmd_free_pass_end_title),
                body = context.getString(R.string.cmd_free_pass_end_body),
                id = NID_FREE_PASS,
            )
        }
    }

    // ── PIN ───────────────────────────────────────────────────────

    private fun handleSetPin(payload: JsonObject?) {
        val pin = payload?.get("pin")?.jsonPrimitive?.contentOrNull
        if (pin.isNullOrBlank() || pin.length < 4) {
            Log.w(TAG, "set_pin: PIN 无效 (空或 <4 位)")
            return
        }
        scope.launch(Dispatchers.IO) {
            val ok = PinManager.setPin(context, pin)
            if (ok) {
                notifyAgent(
                    channel = CMD_CHANNEL,
                    title = context.getString(R.string.cmd_pin_set_title),
                    body = context.getString(R.string.cmd_pin_set_body),
                    id = NID_PIN,
                    logKind = NotifLog.Kind.PIN,
                )
            }
        }
    }

    private fun handleClearPin() {
        scope.launch(Dispatchers.IO) {
            PinManager.clearPin(context)
            notifyAgent(
                channel = CMD_CHANNEL,
                title = context.getString(R.string.cmd_pin_clear_title),
                body = context.getString(R.string.cmd_pin_clear_body),
                id = NID_PIN,
                logKind = NotifLog.Kind.PIN,
            )
        }
    }

    // ── lifecycle ─────────────────────────────────────────────────

    fun reset() {
        unlockExpiryJobs.values.forEach { it.cancel() }
        unlockExpiryJobs.clear()
        freePassJob?.cancel()
        freePassJob = null
    }

    // ── notification helper ──────────────────────────────────────

    private fun notifyAgent(
        channel: String,
        title: String,
        body: String,
        id: Int,
        logKind: NotifLog.Kind = NotifLog.Kind.INFO,
    ) {
        // v0.5.25+ 进通知历史
        NotifLog.add(logKind, title, body)

        ensureChannel(channel)
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(id, n)
    }

    private fun ensureChannel(channel: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(channel) != null) return
        val ch = NotificationChannel(
            channel,
            context.getString(R.string.cmd_notif_channel),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.cmd_notif_channel_desc)
        }
        nm.createNotificationChannel(ch)
    }

    companion object {
        private const val TAG = "CommandHandler"
        private const val CMD_CHANNEL = "agent_command"
        private const val NID_UNLOCK = 3001
        private const val NID_LOCK = 3002
        private const val NID_FREE_PASS = 3003
        private const val NID_PIN = 3004
    }
}
