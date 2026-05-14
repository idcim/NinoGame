package com.ninogame.agent.service

import com.ninogame.agent.net.WsClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** 全局 Agent 运行时状态 — Service 写, UI 读.
 *
 *  这是个进程内单例 (object), 不存盘 — 进程重启 (系统杀后台) 时清零,
 *  UI 显示 "Disconnected" 直到 Service 重新建联. 持久化 (wallet 上次余额 /
 *  上次 hello_ack 时间等) 走 DataStore (data.Settings).
 *
 *  设计取舍: 用 StateFlow 而非 DataStore — 连接状态本质就是 ephemeral,
 *  写盘没意义. wallet/rules 既写这里 (UI 立刻看到) 也写 DataStore (重启 cache).
 */
object AgentState {

    /** WS 连接状态. UI 顶部徽章直接绑这个. */
    val connection: MutableStateFlow<WsClient.ConnectionState> =
        MutableStateFlow(WsClient.ConnectionState.Disconnected)

    /** 服务端推 wallet_update 时实时更新 (null = 还没收到). */
    private val _walletBalance = MutableStateFlow<Int?>(null)
    val walletBalance: StateFlow<Int?> = _walletBalance.asStateFlow()

    /** 从 hello_ack / rules_update 拿到的当前规则条数 (Stage 2a 只展示数量,
     *  Stage 3 解析规则做拦截). */
    private val _rulesCount = MutableStateFlow<Int?>(null)
    val rulesCount: StateFlow<Int?> = _rulesCount.asStateFlow()

    /** 上次 hello_ack 时刻 (epoch ms), UI 显示"连接 N 分钟前同步". */
    private val _lastHelloAckMs = MutableStateFlow<Long?>(null)
    val lastHelloAckMs: StateFlow<Long?> = _lastHelloAckMs.asStateFlow()

    fun onWalletBalance(value: Int) { _walletBalance.value = value }
    fun onRulesCount(value: Int) { _rulesCount.value = value }
    fun onHelloAck() { _lastHelloAckMs.value = System.currentTimeMillis() }
    fun reset() {
        connection.value = WsClient.ConnectionState.Disconnected
        _walletBalance.value = null
        _rulesCount.value = null
        _lastHelloAckMs.value = null
    }
}
