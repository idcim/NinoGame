package com.ninogame.agent.service

import android.content.Context
import android.util.Log
import com.ninogame.agent.net.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 把 CategoryCache.pending 里的未知 package 周期性打包发 server LLM 分类.
 *
 *  跟 Windows agent classifier.py 同语义 (CLAUDE.md §9.3). 协议:
 *
 *    Agent → Server: {type: "unknown_apps", payload: {apps: [{app_identifier, window_title?}]}}
 *    Server → Agent: {type: "app_categories_update", payload: {updates: [{app_identifier, category, sub_type, display_name}]}}
 *
 *  Android 端用 PackageManager 把 pkg 解析成应用标签 (e.g. "com.tencent.mm" → "微信")
 *  当 window_title 发, 给 LLM 强提示 — 跟 Windows agent 用 EXE 文件名 + 窗口标题 一个思路.
 *
 *  生命周期: AgentService WS Open 时 start, 60s 一轮 drainPending + 上报.
 *  WS Disconnected 时 stop, pending 留下次连上时 batch 发.
 */
class UnknownAppsReporter(
    private val scope: CoroutineScope,
    private val wsClient: WsClient,
    private val appContext: Context,
) {
    private var job: Job? = null

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                delay(INTERVAL_MS)
                runCatching { reportOnce() }.onFailure {
                    Log.w(TAG, "unknown_apps tick failed", it)
                }
            }
        }
        Log.i(TAG, "UnknownAppsReporter started; period=${INTERVAL_MS / 1000}s")
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
    }

    private fun reportOnce() {
        if (wsClient.state.value !is WsClient.ConnectionState.Open) return
        val pkgs = CategoryCache.drainPending()
        if (pkgs.isEmpty()) return

        val payload = buildJsonObject {
            put("apps", buildJsonArray {
                for (pkg in pkgs) {
                    add(buildJsonObject {
                        put("app_identifier", pkg)
                        // PackageManager 解析 app label 给 LLM 强提示;
                        // 拿不到 (pkg 卸载边界) 就不带
                        val label = CategoryCache.resolveAppLabel(appContext, pkg)
                        if (!label.isNullOrBlank() && label != pkg) {
                            put("window_title", label)
                        }
                    })
                }
            })
        }
        val msg = buildJsonObject {
            put("type", "unknown_apps")
            put("payload", payload)
        }
        val ok = wsClient.sendJson(msg.toString())
        Log.i(TAG, "unknown_apps sent: ${pkgs.size} pkg; ok=$ok")
        if (!ok) {
            // 发送失败 → 把 pkg 重新放回 pending, 下轮再试
            for (p in pkgs) CategoryCache.noteUnknown(p)
        }
    }

    companion object {
        private const val TAG = "UnknownAppsReporter"
        // 60s 一轮; 短到能让"刚装的 app 启动到出现分类"在合理范围 (1-2 分钟),
        // 长到不浪费 server LLM 请求
        private const val INTERVAL_MS = 60_000L
    }
}
