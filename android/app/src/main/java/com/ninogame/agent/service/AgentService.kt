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
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
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
    private var usageReporter: UsageReporter? = null
    private var unknownAppsReporter: UnknownAppsReporter? = null
    private var commandHandler: CommandHandler? = null
    private var tokenTicker: TokenTicker? = null
    private var screenReceiver: ScreenStateReceiver? = null

    /** v0.5.22+ 低水位提醒 flag — Win agent main._low_balance_warned 同语义.
     *  0 < balance ≤ 10 第一次到时弹一次, 回升到 >10 重置, 避免每个 tick 都弹. */
    private var lowBalanceWarned: Boolean = false
    private val lowBalanceThreshold: Int get() = 10  // TODO: Stage 3c 接 settings.low_balance_warn_threshold

    override fun onBind(intent: Intent?): IBinder? = null

    /** v0.5.12+ 显式 START_STICKY — 进程被 OOM/ROM 杀掉后 Android 自动重新创建
     *  Service (用 null Intent 调 onStartCommand). 跟 Watchdog WorkManager 双层兜底:
     *  系统能拉就系统拉, 系统懒得拉时 Watchdog 15min 一查也能拉. */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        wsClient = WsClient(Api.client, scope)
        currentWs = wsClient  // 暴露给 AccessibilityService 等组件
        usageReporter = UsageReporter(scope, wsClient!!, Settings.from(this))
        unknownAppsReporter = UnknownAppsReporter(scope, wsClient!!, applicationContext)
        commandHandler = CommandHandler(scope, applicationContext)
        tokenTicker = TokenTicker(scope, wsClient!!, applicationContext)

        // v0.5.7+ screen ON/OFF 监听 — idle-lock 5min 自动切 Lock 模式
        screenReceiver = ScreenStateReceiver(scope).also {
            registerReceiver(it, ScreenStateReceiver.intentFilter())
        }

        // v0.5.18+ 运行时发现 launcher + IME 加进 IGNORED_PACKAGES
        // 修 v0.5.6 引入的 bug: 静态硬编码漏 Pixel launcher 等, 导致桌面时也扣 token
        ForegroundAppMonitor.discoverIgnoredPackages(applicationContext)

        // v0.5.3+ 启动时从 DataStore 把 CategoryCache 恢复回内存
        scope.launch { CategoryCache.load(this@AgentService) }

        // 把 ws state mirror 到 AgentState, UI 一行 collectAsState 拿
        scope.launch {
            wsClient!!.state.collectLatest { state ->
                AgentState.connection.value = state
            }
        }

        // v0.5.20+ 监听 outOfToken 变化 — 派生 false→true 的瞬间 (balance 跌到 0,
        // 或 free_pass 到期, 或 mode 切回 Child) 主动 launch MainActivity 强拉到前台.
        //
        // 为什么需要: AccessibilityService 只在 TYPE_WINDOW_STATE_CHANGED 时检查 OOT,
        // 用户已经在 Chrome / 游戏里 + 余额刚跌到 0 时窗口没切换 → 锁屏不触发, 孩子能
        // 继续玩到自己手动切 app. 这里直接监听 state, balance 跌到 0 的瞬间立刻反弹.
        scope.launch {
            var wasOutOfToken = false
            AgentState.outOfToken.collectLatest { now ->
                if (now && !wasOutOfToken) {
                    Log.i(TAG, "outOfToken false→true, launch MainActivity 锁屏")
                    launchMainActivity()
                }
                wasOutOfToken = now
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

        // 3) Open → 发 hello + 启 heartbeat 30s + UsageReporter 5min + UnknownAppsReporter 60s + TokenTicker 60s
        Log.i(TAG, "WS open, sending hello")
        sendHello(agentToken)
        heartbeatJob = scope.launch { heartbeatLoop() }
        usageReporter?.start()
        unknownAppsReporter?.start()
        tokenTicker?.start()

        // 4) 阻塞等到 state 离开 Open (Disconnected 或 Failed)
        ws.state.first {
            it is WsClient.ConnectionState.Disconnected ||
            it is WsClient.ConnectionState.Failed
        }
        Log.i(TAG, "WS closed; cancel heartbeat + reporters + ticker, return for retry")
        heartbeatJob?.cancel()
        usageReporter?.stop()
        unknownAppsReporter?.stop()
        tokenTicker?.stop()
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
"app_categories_update" -> onAppCategoriesUpdate(msg.payload)
            "tasks_update" -> onTasksUpdate(msg.payload)
            "settings_update" -> AgentSettings.applyFromServer(msg.payload)
            "command" -> onCommand(msg.payload)
            "error" -> Log.w(TAG, "server error: ${msg.payload}")
            // Stage 3c+ 会加: settings_update / tasks_update / ...
            else -> Log.d(TAG, "msg ignored (Stage 3b1): ${msg.type}")
        }
    }

    /** 实时 server push command. 单条 (跟 pending_commands batch 区分).
     *  server 端 (backend/src/ws/agent.ts) pushToDevice 时 envelope 是
     *  {type:"command", payload:{ command_type, ... 各 cmd 自己的字段 }} 或者
     *  老格式 {type:"command", payload:{id, command_type, payload:{...}}}. 兼容两种. */
    private fun onCommand(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val cmdType = obj["command_type"]?.jsonPrimitive?.contentOrNull
        val cmdId = obj["id"]?.jsonPrimitive?.contentOrNull
        // 内嵌 payload (v0.4+ server 形态) vs 平铺 (legacy)
        val innerPayload = obj["payload"] ?: obj
        commandHandler?.handle(cmdType, innerPayload, cmdId)
    }

    private fun onTasksUpdate(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val arr = runCatching { obj["tasks"]?.jsonArray }.getOrNull() ?: return
        Log.i(TAG, "tasks_update: ${arr.size} tasks")
        TasksCache.setFromJsonArray(arr)
    }

    private fun onAppCategoriesUpdate(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val updates = runCatching { obj["updates"]?.jsonArray }.getOrNull() ?: return
        val entries = mutableListOf<CategoryCache.Entry>()
        for (u in updates) {
            val o = runCatching { u.jsonObject }.getOrNull() ?: continue
            val pkg = o["app_identifier"]?.jsonPrimitive?.contentOrNull ?: continue
            val cat = o["category"]?.jsonPrimitive?.contentOrNull ?: continue
            val sub = o["sub_type"]?.jsonPrimitive?.contentOrNull ?: ""
            val dn = o["display_name"]?.jsonPrimitive?.contentOrNull
            entries.add(
                CategoryCache.Entry(
                    app_identifier = pkg,
                    category = cat,
                    sub_type = sub,
                    display_name = dn,
                    cached_at_ms = System.currentTimeMillis(),
                )
            )
        }
        if (entries.isNotEmpty()) {
            Log.i(TAG, "app_categories_update: ${entries.size} entries")
            CategoryCache.upsert(entries, applicationContext)
        }
    }

    private fun onHelloAck(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val balance = runCatching { obj["wallet_balance"]?.jsonPrimitive?.intOrNull }.getOrNull()
        val rulesArr = runCatching { obj["rules"]?.jsonArray }.getOrNull()
        val tasksArr = runCatching { obj["tasks"]?.jsonArray }.getOrNull()
        val pendingCmds = runCatching { obj["pending_commands"]?.jsonArray }.getOrNull()
        val settings = obj["settings"]
        Log.i(
            TAG,
            "hello_ack: balance=$balance rules=${rulesArr?.size} tasks=${tasksArr?.size} pending_cmds=${pendingCmds?.size} settings=${settings != null}",
        )
        if (settings != null) AgentSettings.applyFromServer(settings)
        AgentState.onHelloAck()
        if (balance != null) {
            AgentState.onWalletBalance(balance)
            persistBalance(balance)
        }
        if (rulesArr != null) {
            RulesCache.setFromJsonArray(rulesArr)
            AgentState.onRulesCount(rulesArr.size)
        }
        if (tasksArr != null) {
            TasksCache.setFromJsonArray(tasksArr)
        }
        // v0.5.10+ 本日已勾的责任清单 (server 推 task_id[]); 跨页面 / 进程重启恢复
        runCatching { obj["responsibility_today"]?.jsonArray }.getOrNull()?.let { arr ->
            val ids = arr.mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
            TasksCache.setResponsibilityToday(ids)
        }
        // v0.5.5+ 重连后回放 server 积压的命令 (温柔的: server 已经过滤掉 1 小时
        // 前的, 见 backend/src/ws/agent.ts onHello, 不会出现"半夜批准了 30min
        // 解锁早上才生效"这种破事)
        commandHandler?.handlePending(pendingCmds)
    }

    private fun onWalletUpdate(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val balance = obj["balance"]?.jsonPrimitive?.intOrNull ?: return
        val oldBalance = AgentState.walletBalance.value
        Log.i(TAG, "wallet_update: balance=$balance (was=$oldBalance)")
        AgentState.onWalletBalance(balance)
        persistBalance(balance)

        // v0.5.21+ 余额从 ≤0 跌到 >0 + 当前 Lock 模式 → 自动切回 Child.
        // 场景: 孩子按"锁屏休息"或 OOT 锁屏中 → 家长后台 +token / 批 unlock →
        // wallet_update 来了 → 自动解锁回孩子模式 (跟 Windows agent 行为一致;
        // 之前 Android 不解锁, 家长困惑"我转了 token 怎么 App 还锁着").
        // 注意: 只在 0→正 这条边触发, 避免本来余额就 >0 时孩子主动锁屏被立刻解.
        val wasOut = oldBalance == null || oldBalance <= 0
        if (balance > 0 && wasOut && AgentState.mode.value == AgentState.Mode.Lock) {
            Log.i(TAG, "★ 余额恢复 (was=$oldBalance → $balance), Lock 模式自动切回 Child")
            AgentState.setMode(AgentState.Mode.Child)
        }

        // v0.5.22+ 低水位提醒 — 跟 Win agent main._on_wallet_update 对齐.
        // 0 < balance ≤ 10 + 未提醒过 → 弹温和通知 (warn channel, DEFAULT 优先级).
        // balance > 10 → 重置 flag, 下次再到阈值时再提醒. balance ≤ 0 已在 OOT 处理.
        if (balance in 1..lowBalanceThreshold) {
            if (!lowBalanceWarned) {
                lowBalanceWarned = true
                Log.i(TAG, "★ 低水位提醒: balance=$balance ≤ $lowBalanceThreshold")
                BlockNotifier.notifyLowBalance(this, balance)
            }
        } else if (balance > lowBalanceThreshold) {
            if (lowBalanceWarned) {
                lowBalanceWarned = false
                Log.i(TAG, "balance=$balance > 阈值, 重置低水位 flag")
            }
        }
    }

    private fun onRulesUpdate(payload: JsonElement?) {
        val obj = payload as? JsonObject ?: return
        val arr = runCatching { obj["rules"]?.jsonArray }.getOrNull() ?: return
        Log.i(TAG, "rules_update: count=${arr.size}")
        RulesCache.setFromJsonArray(arr)
        AgentState.onRulesCount(arr.size)
    }

    private fun persistBalance(balance: Int) {
        // 写到 DataStore 作为重启 cache. 用 scope.launch 不阻塞当前 IO 流
        scope.launch {
            Settings.from(this@AgentService).saveCachedBalance(balance)
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "AgentService onDestroy")
        usageReporter?.stop()
        unknownAppsReporter?.stop()
        tokenTicker?.stop()
        commandHandler?.reset()
        screenReceiver?.let {
            runCatching { unregisterReceiver(it) }
            screenReceiver = null
        }
        ForegroundAppMonitor.reset()
        RulesCache.reset()
        TasksCache.reset()
        AgentSettings.reset()
        AgentState.reset()
        // CategoryCache 不 reset — 是磁盘缓存, 进程重启希望恢复
        currentWs = null
        scope.cancel()
        wsClient?.close()
        super.onDestroy()
    }

    /** 把 MainActivity 强拉到前台 — outOfToken 变 true 时主动锁屏 (跟
     *  NinoAccessibilityService 的 launchSelfToFront 同语义, 但从 Service 触发).
     *  Android 10+ 后台启 Activity 受限, Foreground Service 是合法路径. */
    private fun launchMainActivity() {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        runCatching { startActivity(intent) }
            .onFailure { Log.w(TAG, "launchMainActivity failed", it) }
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
        private const val VERSION_NAME = "0.5.4-android"

        /** 当前活跃实例的 wsClient — 给 AccessibilityService 等其它组件
         *  上报 event 用. volatile 因为跨线程读 (AccessibilityService 在主线程, AgentService 在 IO). */
        @Volatile
        private var currentWs: WsClient? = null

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

        /** 给 AccessibilityService 上报 block 事件用. WS 没连上返 false. */
        fun sendEvent(eventType: String, payload: JsonObject): Boolean {
            val ws = currentWs ?: return false
            if (ws.state.value !is WsClient.ConnectionState.Open) return false
            val msg = buildJsonObject {
                put("type", "event")
                put("payload", buildJsonObject {
                    put("event_type", eventType)
                    put("payload", payload)
                })
            }
            return ws.sendJson(msg.toString())
        }

        /** v0.5.8+ 申报激励任务完成 — {type:task_claim, payload:{task_id, child_note?}}.
         *  server.onTaskClaim 写 task_completions(status=pending) 推家长 frontend 审批. */
        fun sendTaskClaim(taskId: String, childNote: String? = null): Pair<Boolean, String?> {
            val ws = currentWs ?: return false to "Agent 服务没在跑"
            if (ws.state.value !is WsClient.ConnectionState.Open) {
                return false to "未联机 (Agent 会自动重连, 稍后再试)"
            }
            if (taskId.isBlank()) return false to "任务 ID 为空"
            val msg = buildJsonObject {
                put("type", "task_claim")
                put("payload", buildJsonObject {
                    put("task_id", taskId)
                    if (!childNote.isNullOrBlank()) put("child_note", childNote)
                })
            }
            val ok = ws.sendJson(msg.toString())
            return if (ok) true to null else false to "网络发送失败"
        }

        /** v0.5.8+ 责任清单勾选/取消 — 走 event 通道 (event_type=checklist_tick).
         *  server.onEvent 拆出 checklist_tick 进 responsibility_checks 表 upsert. */
        fun sendChecklistTick(taskId: String, completed: Boolean): Boolean {
            return sendEvent("checklist_tick", buildJsonObject {
                put("task_id", taskId)
                put("completed", completed)
            })
        }

        /** v0.5.7+ 申请游戏时间 — 跟 Windows agent _submit_unlock_request 同协议:
         *  {type:unlock_request, payload:{request_text, structured:{}}}.
         *  return: (ok, errorMessage). 失败时 errorMessage 非空给 UI 显示. */
        fun sendUnlockRequest(text: String): Pair<Boolean, String?> {
            val ws = currentWs
                ?: return false to "Agent 服务没在跑 — 重启 App 试试"
            if (ws.state.value !is WsClient.ConnectionState.Open) {
                return false to "未联机 (Agent 会自动重连, 稍后再试)"
            }
            if (text.isBlank()) return false to "请先输入想说的话"
            val msg = buildJsonObject {
                put("type", "unlock_request")
                put("payload", buildJsonObject {
                    put("request_text", text)
                    put("structured", buildJsonObject {})
                })
            }
            val ok = ws.sendJson(msg.toString())
            return if (ok) true to null else false to "网络发送失败"
        }
    }
}
