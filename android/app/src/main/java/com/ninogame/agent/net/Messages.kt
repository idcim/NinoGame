package com.ninogame.agent.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** WS 消息 envelope — Server / Agent 双向共用. Stage 2+ 用. */
@Serializable
data class WsMessage(
    val type: String,
    val id: String? = null,
    val ts: String? = null,
    val payload: JsonElement? = null,
)

/** Agent → Server: hello 鉴权握手. */
@Serializable
data class HelloPayload(
    @SerialName("agent_token") val agentToken: String,
    @SerialName("device_info") val deviceInfo: DeviceInfo,
    @SerialName("agent_version") val agentVersion: String,
)

@Serializable
data class DeviceInfo(
    val platform: String = "android",
    @SerialName("os_release") val osRelease: String,
    @SerialName("os_sdk") val osSdk: Int,
    val model: String,
)

/** Server → Agent: hello_ack 全量同步初始状态. */
@Serializable
data class HelloAck(
    val rules: List<RuleSpec>? = null,
    @SerialName("wallet_balance") val walletBalance: Int? = null,
    @SerialName("pending_commands") val pendingCommands: List<JsonElement>? = null,
)

/** Stage 2+ 时 fields 加全. 这版仅 stub 让协议字段对得齐. */
@Serializable
data class RuleSpec(
    val id: String,
    val name: String,
    val enabled: Boolean = true,
)
