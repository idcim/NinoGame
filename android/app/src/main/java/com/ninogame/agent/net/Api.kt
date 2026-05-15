package com.ninogame.agent.net

import android.os.Build
import com.ninogame.agent.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.util.concurrent.TimeUnit

/** HTTP 客户端 — 当前仅做配对兑换. WebSocket 用同一个 [client] 实例
 *  (OkHttp 文档推荐 client 全局单例, 协议升级到 ws 不用新建).
 */
object Api {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    val client: OkHttpClient by lazy {
        val log = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG)
                HttpLoggingInterceptor.Level.BODY
            else
                HttpLoggingInterceptor.Level.NONE
        }
        OkHttpClient.Builder()
            .addInterceptor(log)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            // v0.5.18+ 必须设 pingInterval — 之前没设, Server `onHeartbeat` 只
            // 更新 last_seen_at 不回任何消息, OkHttp 一直读不到 frame, 30s
            // readTimeout 触发后 disconnect → connectLoop 1-2s 后重连 → TokenTicker
            // 60s 间隔永远跑不满 → 实际不扣 token. 走 WS 协议级 PING/PONG, server
            // 自动响应, 无需 server 改代码; 20s < 30s readTimeout 留一档安全余量。
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }

    /** 服务端 /api/devices/pair/redeem 的响应. */
    @Serializable
    data class RedeemResp(
        val agent_token: String,
        val device_id: String,
        val child_id: String? = null,
    )

    @Serializable
    private data class ErrorResp(
        val message: String? = null,
        val error: String? = null,
    )

    /** 拿 8 位 code 跟后端兑换 agent_token. 失败抛 [ApiException]. */
    suspend fun redeemPairingCode(backendUrl: String, code: String): RedeemResp = withContext(Dispatchers.IO) {
        val url = backendUrl.trimEnd('/') + "/api/devices/pair/redeem"
        val osInfo: JsonElement = buildJsonObject {
            put("platform", "android")
            put("android_release", Build.VERSION.RELEASE)
            put("android_sdk", Build.VERSION.SDK_INT)
            put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}")
        }
        val payload = json.encodeToString(buildJsonObject {
            put("code", code)
            put("platform", "android")
            put("os_info", osInfo)
        })
        val req = Request.Builder()
            .url(url)
            .post(payload.toRequestBody(JSON_TYPE))
            .build()
        client.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val msg = runCatching { json.decodeFromString<ErrorResp>(body) }
                    .getOrNull()?.message
                    ?: body.take(200).ifBlank { "HTTP ${resp.code}" }
                throw ApiException(resp.code, msg)
            }
            return@use json.decodeFromString(RedeemResp.serializer(), body)
        }
    }

    private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()
}

class ApiException(val status: Int, message: String) : RuntimeException(message)

/** PairScreen 也支持粘贴魔法链接 "https://host/#pair=ABCDEFGH" 直接解析,
 *  跟 Windows agent pair.py 同款解析逻辑. */
object MagicLink {
    private val CODE_RE = Regex("""[#?&]pair=([A-Za-z0-9]{4,16})""")

    data class Parsed(val backendUrl: String, val code: String)

    /** 接受三种输入:
     *    "https://host/#pair=ABCDEFGH"   → backendUrl=https://host, code=ABCDEFGH
     *    "https://host"                  → 还没 code, 返 null
     *    "ABCDEFGH"                      → 还没 host, 返 null
     *  调用方拼齐两半再调 [Api.redeemPairingCode].
     */
    fun parse(input: String): Parsed? {
        val trimmed = input.trim()
        val m = CODE_RE.find(trimmed) ?: return null
        val code = m.groupValues[1]
        // 把 host 部分剪出来 (#pair= 之前的 origin)
        val cutAt = trimmed.indexOf("#")
        val urlPart = (if (cutAt > 0) trimmed.substring(0, cutAt) else trimmed).trimEnd('/')
        if (!urlPart.startsWith("http")) return null
        return Parsed(urlPart, code)
    }
}
