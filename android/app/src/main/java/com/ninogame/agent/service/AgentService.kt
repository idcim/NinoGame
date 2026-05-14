package com.ninogame.agent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.ninogame.agent.MainActivity
import com.ninogame.agent.R
import com.ninogame.agent.data.Settings
import com.ninogame.agent.net.Api
import com.ninogame.agent.net.WsClient
import com.ninogame.agent.net.WsMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Foreground Service — 持 WebSocket 长连接 + heartbeat + 接收 wallet/rules.
 *
 *  生命周期:
 *    - MainActivity 检测到已配对 → startForegroundService(this)
 *    - Service onCreate: 启动协程 connectLoop, 监听 Settings (backendUrl / agentToken)
 *      变化, 一变就重连
 *    - 解配对 (Settings.clearPairing): Settings flow 触发, connectLoop 自然停下,
 *      MainActivity 也会 stopService
 *
 *  断线策略 (Stage 2a):
 *    - 连接失败 → 指数退避 1s/2s/4s/.../60s 封顶
 *    - 成功 → backoff 重置
 *    - heartbeat 30s 一次, 失败/超时由 OkHttp 自身的 read timeout 触发 onFailure
 *
 *  Stage 2b+ 会加: AccessibilityService 监前台 app + usage_report 上报
 *  Stage 3+: 接收 command (temporary_unlock / start_free_pass / ...)
 */
class AgentService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var wsClient: WsClient? = null
    private var connectJob: Job? = null
    private var heartbeatJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        wsClient = WsClient(Api.client, scope)

        // 把 ws state mirror 到 AgentState, UI 一行 collectAsState 拿
        scope.launch {
            wsClient!!.state.collectLatest { state ->
                AgentState.connection.value = state
            }
        }

        // 监听 (backendUrl, agentToken) 任一变 → 重启连接
        val settings = Settings.from(this)
        scope.launch {
            combine(settings.backendUrl, settings.agentToken) { url, token ->
                if (url.isNullOrBlank() || token.isNullOrBlank()) null
                else url to token
            }.collectLatest { pair ->
                connectJob?.cancel()
                heartbeatJob?.cancel()
                wsClient?.close()
                if (pair == null) {
                    Log.i(TAG, "no pairing — staying disconnected")
                    return@collectLatest
                }
                val (url, token) = pair
                connectJob = scope.launch { connectLoop(url, token) }
            }
        }
    }

    /** 指数退避连接循环 — 直到 scope 被取消或 settings 触发 collectLatest 把它换掉. */
    private suspend fun connectLoop(backendUrl: String, agentToken: String) {
        var backoffMs = INITIAL_BACKOFF_MS
        while (scope.isActive) {
            connectOnce(backendUrl, agentToken)
            // connectOnce 返回时 = 已断或失败. 重试前等 backoff
            Log.i(TAG, "WS disconnected; reconnect in ${backoffMs}ms")
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
            // 注: 不 reset backoff 在成功开后, 是为了简化; 连续成功开了后 backoff
            // 仍是 1s (下次失败重新增). 如果想"成功 30s 后重置 backoff" 改 connectOnce
            // 里加一个 settle 计时.
        }
    }

    /** 单次连接: 建联 → 等 Open → 发 hello + 心跳 → 等终态 → 返回.
     *  阻塞返回 = 已断, connectLoop 退避后重试. */
    private suspend fun connectOnce(backendUrl: String, agentToken: String) {
        val ws = wsClient ?: return
        heartbeatJob?.cancel()

        // 1) 调 connect — 同步把 state 推到 Connecting; OkHttp 异步 onOpen/onFailure
        ws.connect(backendUrl, agentToken) { msg -> handleMessage(msg) }

        // 2) 等到非 Connecting 的"决定态" — Open 或 Failed
        val firstStable = ws.state.first {
            it is WsClient.ConnectionState.Open ||
            it is WsClient.ConnectionState.Failed
        }

        // Failed → 直接走出去等退避
        if (firstStable is WsClient.ConnectionState.Failed) {
            Log.w(TAG, "WS failed to open: ${firstStable.cause}")
            return
        }

        // 3) Open → 发 hello + 启动 heartbeat 30s
        Log.i(TAG, "WS open, sending hello")
        sendHello(agentToken)
        heartbeatJob = scope.launch { heartbeatLoop() }

        // 4) 阻塞等到 state 离开 Open (Disconnected 或 Failed)
        ws.state.first {
            it is WsClient.ConnectionState.Disconnected ||
            it is WsClient.ConnectionState.Failed
        }
        Log.i(TAG, "WS closed; cancel heartbeat, return for retry")
        heartbeatJob?.cancel()
    }

    private suspend fun heartbeatLoop() {
        val ws = wsClient ?: return
        while (scope.isActive && ws.state.value is WsClient.ConnectionState.Open) {
            delay(HEARTBEAT_INTERVAL_MS)
            if (ws.state.value !is WsClient.ConnectionState.Open) break
            val msg = buildJsonObject {
                put("type", "heartbeat")
                put("ts", System.currentTimeMillis().toString())
            }
            ws.sendJson(msg.toString())
        }
    }

    private fun sendHello(@Suppress("UNUSED_PARAMETER") agentToken: String) {
        val msg = buildJsonObject {
            put("type", "hello")
            put("payload", buildJsonObject {
                put("agent_version", VERSION_NAME)
                put("platform", "android")
                put("os_release", Build.VERSION.RELEASE)
                put("os_sdk", Build.VERSION.SDK_INT)
                put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            })
        }
        wsClient?.sendJson(msg.toString())
    }

    private fun handleMessage(msg: WsMessage) {
        when (msg.type) {
            "hello_ack" -> onHelloAck(msg.payload)
            "wallet_update" -> onWalletUpdate(msg.payload)
            "rules_update" -> onRulesUpdate(msg.payload)
            "error" -> Log.w(TAG, "server error: ${msg.payload}")
            // Stage 3 会加: command / app_categories_update / settings_update / tasks_update / ...
            else -> Log.d(TAG, "msg ignored (Stage 2a): ${msg.type}")
        }
    }

    private fun onHelloAck(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val balance = runCatching { obj["wallet_balance"]?.jsonPrimitive?.intOrNull }.getOrNull()
        val rulesCount = runCatching { obj["rules"]?.jsonArray?.size }.getOrNull()
        Log.i(TAG, "hello_ack: balance=$balance rules=$rulesCount")
        AgentState.onHelloAck()
        if (balance != null) {
            AgentState.onWalletBalance(balance)
            persistBalance(balance)
        }
        if (rulesCount != null) AgentState.onRulesCount(rulesCount)
    }

    private fun onWalletUpdate(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val balance = obj["balance"]?.jsonPrimitive?.intOrNull ?: return
        Log.i(TAG, "wallet_update: balance=$balance")
        AgentState.onWalletBalance(balance)
        persistBalance(balance)
    }

    private fun onRulesUpdate(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val count = runCatching { obj["rules"]?.jsonArray?.size }.getOrNull() ?: return
        Log.i(TAG, "rules_update: count=$count")
        AgentState.onRulesCount(count)
    }

    private fun persistBalance(balance: Int) {
        // 写到 DataStore 作为重启 cache. 用 scope.launch 不阻塞当前 IO 流
        scope.launch {
            Settings.from(this@AgentService).saveCachedBalance(balance)
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "AgentService onDestroy")
        AgentState.reset()
        scope.cancel()
        wsClient?.close()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        // API 26+ 需要 channel; API 24/25 直接 builder 即可
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notif_channel_agent),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = getString(R.string.notif_channel_agent_desc)
                    setShowBadge(false)
                }
                nm.createNotificationChannel(ch)
            }
        }
        val pendingFlags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            pendingFlags,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth) // Stage 3 换品牌图标
            .setContentTitle(getString(R.string.notif_agent_title))
            .setContentText(getString(R.string.notif_agent_text))
            .setContentIntent(openApp)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        private const val TAG = "AgentService"
        private const val NOTIF_ID = 1001
        private const val CHANNEL_ID = "agent_service"
        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val INITIAL_BACKOFF_MS = 1_000L
        private const val MAX_BACKOFF_MS = 60_000L
        private const val VERSION_NAME = "0.5.1-android"

        /** 启动 Service. MainActivity 在已配对时调一次. */
        fun start(ctx: Context) {
            val intent = Intent(ctx, AgentService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, AgentService::class.java))
        }
    }
}
