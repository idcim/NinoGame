package com.ninogame.agent.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Token 变动历史 — 跟 Win agent wallet.list_recent_ledger / LedgerWindow 等价.
 *
 *  v0.5.25 起点: 内存版, 进程重启清零. Stage 4 再 Room DB / 拉 backend `/api/.../ledger`.
 *
 *  过滤: server 推 wallet_update 的 reason=app_consumption (每分钟扣 1) **不入**,
 *  跟 Win agent "只看家长操作 + 任务奖励等" 同语义. 每分钟扣的细节 ledger 主要是审计,
 *  孩子端展示太吵.
 */
object LedgerLog {

    data class Entry(
        val ts: Long,
        val delta: Int,
        val balanceAfter: Int,
        val reason: String,
    )

    /** 跳过的 reason — server 推 wallet_update 时这些不入 ledger UI.
     *  app_consumption = 每分钟 -1, 太吵; server_sync = 强同步无变化. */
    private val SKIPPED_REASONS = setOf("app_consumption", "server_sync")

    private const val MAX = 100

    private val deque = ArrayDeque<Entry>(MAX)
    private val _entries = MutableStateFlow<List<Entry>>(emptyList())
    val entries: StateFlow<List<Entry>> = _entries.asStateFlow()

    @Synchronized
    fun add(delta: Int, balanceAfter: Int, reason: String) {
        if (reason in SKIPPED_REASONS) return
        // delta 0 也跳 (server_sync 兜底)
        if (delta == 0) return
        val e = Entry(System.currentTimeMillis(), delta, balanceAfter, reason)
        deque.addFirst(e)
        while (deque.size > MAX) deque.removeLast()
        _entries.value = deque.toList()
    }

    @Synchronized
    fun clear() {
        deque.clear()
        _entries.value = emptyList()
    }

    /** UI 友好的 reason 标签 — 跟 Win agent render_ledger_row 同款. */
    fun labelOf(reason: String): String = when (reason) {
        "parent_grant" -> "家长发放"
        "task_reward" -> "任务奖励"
        "daily_grant" -> "每日基础"
        "streak_bonus" -> "连续奖励"
        "unlock_prepay" -> "申请预扣"
        "refund" -> "退款"
        "adjustment" -> "调账"
        else -> reason
    }
}
