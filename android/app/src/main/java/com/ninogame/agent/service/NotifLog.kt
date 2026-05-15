package com.ninogame.agent.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** 通知历史环形 buffer — 跟 Win agent main.notif_repo / MessagesWindow 等价.
 *
 *  v0.5.25 起点: 内存版, 进程重启清零. Stage 4 再用 Room DB 持久化跨进程.
 *
 *  写: BlockNotifier.notify* / CommandHandler 各分支 / AgentService 命令处理.
 *  读: ui.MessagesScreen 通过 [entries] StateFlow 响应式渲染列表.
 *
 *  上限 100 条 (跟 Win 默认 list_recent(50) 留余量, UI 自行 take(50) 展示).
 */
object NotifLog {

    enum class Kind {
        BLOCK,           // 规则拦截命中
        OUT_OF_TOKEN,    // 余额耗尽锁屏
        LOW_BALANCE,     // 低水位提醒
        UNLOCK,          // 家长批准临时解锁
        LOCK,            // 家长远程锁定
        FREE_PASS,       // 限免开始 / 结束
        PIN,             // PIN 变更
        INFO,            // 通用信息
    }

    data class Entry(
        val ts: Long,
        val kind: Kind,
        val title: String,
        val body: String,
    )

    private const val MAX = 100

    private val deque = ArrayDeque<Entry>(MAX)
    private val _entries = MutableStateFlow<List<Entry>>(emptyList())
    val entries: StateFlow<List<Entry>> = _entries.asStateFlow()

    @Synchronized
    fun add(kind: Kind, title: String, body: String) {
        val e = Entry(System.currentTimeMillis(), kind, title, body)
        deque.addFirst(e)
        while (deque.size > MAX) deque.removeLast()
        _entries.value = deque.toList()
    }

    @Synchronized
    fun clear() {
        deque.clear()
        _entries.value = emptyList()
    }
}
