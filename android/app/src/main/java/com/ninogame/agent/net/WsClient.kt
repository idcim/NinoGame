package com.ninogame.agent.net

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/** WebSocket 长连接客户端 — Stage 1 暂只搭骨架 + 自动连/断/重连.
 *  Stage 2 实际 hello 握手 + heartbeat + 接收 rules_update / wallet_update / command.
 *
 *  设计:
 *    - 单例 WsClient 持一个 OkHttp 连接.
 *    - state Flow 暴露连接状态 ([State]).
 *    - 调用方在 [ConnectionState.Open] 时才 send() 业务消息.
 *    - 断线指数退避重连 (1s/2s/4s/.../60s) 由调用方控制, 这里只暴露 reconnect().
 */
class WsClient(
    private val httpClient: OkHttpClient,
    private val scope: CoroutineScope,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    sealed interface ConnectionState {
        data object Disconnected : ConnectionState
        data object Connecting   : ConnectionState
        data object Open         : ConnectionState
        data class Failed(val cause: String) : ConnectionState
    }

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private var socket: WebSocket? = null

    /** 建立连接. backendUrl 是 http(s)://, OkHttp 自动转 ws(s):// 升级. */
    fun connect(backendUrl: String, agentToken: String, onMessage: (WsMessage) -> Unit) {
        val wsUrl = backendUrl.trimEnd('/')
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://") + "/ws/agent"
        val req = Request.Builder()
            .url(wsUrl)
            .header("Authorization", "Bearer $agentToken")
            .build()
        _state.value = ConnectionState.Connecting
        socket = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.i(TAG, "WS open: ${response.code}")
                _state.value = ConnectionState.Open
            }

            override fun onMessage(ws: WebSocket, text: String) {
                runCatching {
                    val msg = json.decodeFromString(WsMessage.serializer(), text)
                    onMessage(msg)
                }.onFailure { Log.w(TAG, "WS msg decode failed: $text", it) }
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                // server 当前只发文本; 二进制忽略
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WS closing: $code $reason")
                ws.close(NORMAL_CLOSE, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                _state.value = ConnectionState.Disconnected
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WS failure: ${t.message}", t)
                _state.value = ConnectionState.Failed(t.message ?: "unknown")
            }
        })
    }

    fun sendJson(text: String): Boolean = socket?.send(text) ?: false

    fun close() {
        socket?.close(NORMAL_CLOSE, "client_disconnect")
        socket = null
        _state.value = ConnectionState.Disconnected
    }

    @Suppress("unused") // Stage 2+ 用
    val _scopeRef: CoroutineScope get() = scope

    companion object {
        private const val TAG = "WsClient"
        private const val NORMAL_CLOSE = 1000
    }
}
