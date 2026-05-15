package com.ninogame.agent.service

import android.content.Context
import android.os.PowerManager
import android.util.Log
import com.ninogame.agent.net.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 每分钟一次 token_tick — 让 server 单一权威扣分 (CLAUDE.md 决策 #34).
 *
 *  跟 Windows agent core/token_engine.py 同协议. Android 端**不本地 deduct**,
 *  只发"扣多少"的意图给 server, server 写 ledger + UPDATE wallets + 推 wallet_update
 *  回 Agent (AgentService.onWalletUpdate 同步 AgentState).
 *
 *  发送条件 (CLAUDE.md 决策 #36 "在跑就扣", 跟 Win agent token_engine 对齐):
 *    1. AgentState.mode == Child (Lock / Parent 不扣)
 *    2. !AgentState.isFreePassActive (限免期间消费不扣, §7.5)
 *    3. WS Open (离线不扣, §7.6)
 *    4. PowerManager.isInteractive (屏幕亮; 屏幕灭 = 没在看, 不扣)
 *
 *  v0.5.23 修: 去掉了 "foregroundApp != null" 检查 — 用户反馈"开着就该扣".
 *  之前桌面 (launcher 进 IGNORED → foregroundApp=null) / 自家 App 前台都不扣,
 *  孩子能在桌面停着不扣分. 现在 mode=Child + 屏幕亮 + WS Open 就扣, 没前台
 *  signal 时 pkg 走 "(idle)" 占位, server 仍记 ledger.
 *
 *  amount: v0.5.6 hard-code 1.0 (每分钟 1 token, 跟 Windows agent
 *  settings.token_to_minute_ratio 默认一致). Stage 3c 监听 server 推 settings_update
 *  时可动态调.
 *
 *  生命周期: AgentService WS Open 时启动, Disconnected 时停. 跟 UsageReporter /
 *  UnknownAppsReporter 一致.
 */
class TokenTicker(
    private val scope: CoroutineScope,
    private val wsClient: WsClient,
    private val context: Context,
) {
    private var job: Job? = null

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                // 每轮重新读 settings — 家长后台改 billing_tick_seconds 当场生效, 不用重启
                val intervalMs = AgentSettings.current().billingTickSeconds * 1000L
                delay(intervalMs.coerceIn(10_000L, 600_000L))
                runCatching { tickOnce() }.onFailure {
                    Log.w(TAG, "token_tick failed", it)
                }
            }
        }
        Log.i(TAG, "TokenTicker started; reads AgentSettings each tick")
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
    }

    private fun tickOnce() {
        // ── 4 个条件依次短路 — 任一不满足跳过, 配 logcat 排查问题方便
        if (AgentState.mode.value != AgentState.Mode.Child) {
            Log.d(TAG, "skip: mode=${AgentState.mode.value}")
            return
        }
        if (AgentState.isFreePassActive()) {
            Log.d(TAG, "skip: free_pass active")
            return
        }
        if (wsClient.state.value !is WsClient.ConnectionState.Open) {
            Log.d(TAG, "skip: ws not open")
            return
        }
        if (!isScreenInteractive()) {
            Log.d(TAG, "skip: screen off / non-interactive")
            return
        }
        // 注: 不再检查 foregroundApp != null — 桌面/IME/自家 App 一律照扣 (决策 #36).
        // 没前台 signal 时用 "(idle)" 占位让 server ledger 看得出来源.
        val pkg = ForegroundAppMonitor.foregroundApp.value?.takeIf { it.isNotBlank() } ?: "(idle)"

        // 满足全部条件 — 发 tick. amount + tick_seconds 都从 AgentSettings 拿,
        // 跟 Windows agent settings.token_to_minute_ratio 同一源
        val s = AgentSettings.current()
        val msg = buildJsonObject {
            put("type", "token_tick")
            put("payload", buildJsonObject {
                put("amount", s.tokenToMinuteRatio)
                put("ref_id", pkg)
                put("app", pkg)
                put("tick_seconds", s.billingTickSeconds)
            })
        }
        val sent = wsClient.sendJson(msg.toString())
        Log.i(TAG, "token_tick sent: -${s.tokenToMinuteRatio} ($pkg); ok=$sent")
    }

    private fun isScreenInteractive(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isInteractive
    }

    companion object {
        private const val TAG = "TokenTicker"
    }
}
