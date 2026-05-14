package com.ninogame.agent.service

import android.util.Log
import com.ninogame.agent.data.Settings
import com.ninogame.agent.net.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** 5 分钟一次把 ForegroundAppMonitor 收集到的 segments 打包成 usage_report 发 server.
 *
 *  跟 Windows agent comms/usage_reporter.py 同协议 (CLAUDE.md §10.4).
 *  Server 端 onUsageReport (backend/src/ws/agent.ts) 写 app_sessions 历史 +
 *  不再扣 wallet (决策 #34 后双重扣分修复).
 *
 *  生命周期:
 *    AgentService 在 connectOnce Open 后调 [start]; ws disconnect / service stop
 *    调 [stop]. 多次 start 防重入.
 *
 *  Stage 2b 简化:
 *    - category 全填 "neutral" — server 端 LATERAL JOIN app_categories 自己分类,
 *      孩子端不带本地 cache. Stage 2c 加 unknown_apps 消息让 server LLM 分类后推回.
 *    - rate / idle_seconds / tokens_consumed 全 0 (Android 端不参与扣分决策,
 *      server `token_tick` 链路才扣)
 */
class UsageReporter(
    private val scope: CoroutineScope,
    private val wsClient: WsClient,
    private val settings: Settings,
) {
    private var job: Job? = null

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            // 启动后立刻进入 5min loop. 第一次也等满 5min 再发, 避免刚 paired
            // 完空数据浪费请求.
            while (isActive) {
                delay(INTERVAL_MS)
                runCatching { reportOnce() }.onFailure {
                    Log.w(TAG, "usage_report tick failed", it)
                }
            }
        }
        Log.i(TAG, "UsageReporter started; period=${INTERVAL_MS / 60_000}min")
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
    }

    private suspend fun reportOnce() {
        // 没 ws 连上就跳过这一周期, segments 留到下次 drain
        if (wsClient.state.value !is WsClient.ConnectionState.Open) {
            Log.d(TAG, "skip tick: ws not open")
            return
        }
        val childId = settings.childId.first() ?: return
        val deviceId = settings.deviceId.first() ?: return

        val periodEndMs = System.currentTimeMillis()
        val segments = ForegroundAppMonitor.drainSegments()
        if (segments.isEmpty()) {
            Log.d(TAG, "skip tick: 0 segments")
            return
        }
        val periodStartMs = segments.minOf { it.startedAtMs }

        val payload = buildJsonObject {
            put("child_id", childId)
            put("device_id", deviceId)
            put("period_start", iso8601(periodStartMs))
            put("period_end", iso8601(periodEndMs))
            put("foreground_segments", buildJsonArray {
                for (s in segments) {
                    add(buildJsonObject {
                        put("app", s.app)
                        // Stage 2b: 全 neutral; Stage 2c+ 走 unknown_apps 让 server 分类
                        put("category", "neutral")
                        put("rate", 0.0)
                        put("active_seconds", s.activeSeconds)
                        put("idle_seconds", 0)
                        put("tokens_consumed", 0)
                    })
                }
            })
            put("segment_count_raw", segments.size)
        }
        val envelope = buildJsonObject {
            put("type", "usage_report")
            put("ts", iso8601(periodEndMs))
            put("payload", payload)
        }
        val ok = wsClient.sendJson(envelope.toString())
        Log.i(
            TAG,
            "usage_report sent: segments=${segments.size} period=${(periodEndMs - periodStartMs) / 1000}s ok=$ok",
        )
    }

    private fun iso8601(ms: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).apply {
            timeZone = TimeZone.getDefault()
        }
        return fmt.format(Date(ms))
    }

    companion object {
        private const val TAG = "UsageReporter"
        // 5 分钟跟 Windows agent 一致
        private const val INTERVAL_MS = 5 * 60 * 1000L
    }
}
