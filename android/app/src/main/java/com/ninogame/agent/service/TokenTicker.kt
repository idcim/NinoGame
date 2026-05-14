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
 *  发送条件 (全部要满足才扣):
 *    1. AgentState.mode == Child (lock 模式不扣, 决策 #36 "在跑就扣")
 *    2. !AgentState.isFreePassActive (限免期间消费不扣, §7.5)
 *    3. WS Open (离线不扣, §7.6)
 *    4. ForegroundAppMonitor.foregroundApp 非 null (屏幕在用; ForegroundAppMonitor
 *       已经把 IGNORED launcher/自家 app expose 成 null, 不会扣)
 *    5. PowerManager.isInteractive (屏幕亮; 屏幕灭说明孩子没在看, 不扣 — Android 没
 *       Windows 那种 GetLastInputInfo, 这是最实用的"在用" 信号)
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
                delay(INTERVAL_MS)
                runCatching { tickOnce() }.onFailure {
                    Log.w(TAG, "token_tick failed", it)
                }
            }
        }
        Log.i(TAG, "TokenTicker started; period=${INTERVAL_MS / 1000}s amount=$AMOUNT_PER_TICK")
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
    }

    private fun tickOnce() {
        // ── 5 个条件依次短路 — 任一不满足跳过, 配 logcat 排查问题方便
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
        val pkg = ForegroundAppMonitor.foregroundApp.value
        if (pkg.isNullOrBlank()) {
            Log.d(TAG, "skip: no foreground app")
            return
        }

        // 满足全部条件 — 发 tick
        val msg = buildJsonObject {
            put("type", "token_tick")
            put("payload", buildJsonObject {
                put("amount", AMOUNT_PER_TICK)
                put("ref_id", pkg)
                put("app", pkg)
                put("tick_seconds", INTERVAL_MS / 1000)
            })
        }
        val sent = wsClient.sendJson(msg.toString())
        Log.i(TAG, "token_tick sent: -$AMOUNT_PER_TICK ($pkg); ok=$sent")
    }

    private fun isScreenInteractive(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isInteractive
    }

    companion object {
        private const val TAG = "TokenTicker"
        // 60s 跟 Windows agent billing_tick_seconds 默认一致
        private const val INTERVAL_MS = 60_000L
        // 每 tick 扣多少 token — Stage 3b2 hard-code 1.0, Stage 3c 接 server settings_update
        private const val AMOUNT_PER_TICK = 1.0
    }
}
