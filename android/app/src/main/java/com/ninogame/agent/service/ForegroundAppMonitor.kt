package com.ninogame.agent.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** 前台 app 监控的进程内 singleton.
 *
 *  写: NinoAccessibilityService.onAccessibilityEvent 每次窗口状态变化调 [setForeground]
 *  读: UsageReporter 每 5min 调 [drainSegments] 把已结束的 segments 拿走; UI 调
 *      [foregroundApp] StateFlow 显示当前前台.
 *
 *  Segment 模型:
 *    - 当 app 切换 (旧 != 新): 当前 _openSegment 终止 (active_seconds = now - start),
 *      推入 _closedSegments, 开新的 open segment
 *    - drainSegments(): 取走 _closedSegments 列表 (clear); 当前 open 不动 (跨周期会自然
 *      跨入下次)
 *
 *  线程安全: AccessibilityService.onAccessibilityEvent 在主线程; UsageReporter
 *  在 IO 协程. 全部用 @Synchronized 锁住 mutator 方法即可.
 *
 *  自家 app + 系统 launcher 用一个 builtin 黑名单过滤掉, 不进 segments (没意义).
 */
object ForegroundAppMonitor {

    /** 一段 app 前台使用记录 — 跟 Windows agent app_session 同语义. */
    data class Segment(
        val app: String,
        val startedAtMs: Long,
        val endedAtMs: Long,
        val activeSeconds: Int,
    )

    private val _foregroundApp = MutableStateFlow<String?>(null)
    val foregroundApp: StateFlow<String?> = _foregroundApp.asStateFlow()

    /** UI 调试用: 总 closed segments 计数, 每次 drain 后会重置. */
    private val _pendingSegmentCount = MutableStateFlow(0)
    val pendingSegmentCount: StateFlow<Int> = _pendingSegmentCount.asStateFlow()

    private var openApp: String? = null
    private var openStartMs: Long = 0L
    private val closedSegments = mutableListOf<Segment>()

    /** 不计入 segments 的包 (自家 app + 系统/launcher 类). */
    private val IGNORED_PACKAGES = setOf(
        "com.ninogame.agent",
        "com.ninogame.agent.debug",
        "android",
        "com.android.systemui",
        "com.android.launcher",
        "com.android.launcher3",
        "com.miui.home",
        "com.huawei.android.launcher",
        "com.oppo.launcher",
        "com.vivo.launcher",
    )

    @Synchronized
    fun setForeground(packageName: String?) {
        if (packageName.isNullOrBlank()) return
        if (packageName == openApp) return // 同 app 内 Activity 切, 忽略
        val now = System.currentTimeMillis()

        // 关掉当前 open segment
        openApp?.let { prevApp ->
            val activeSec = ((now - openStartMs) / 1000).toInt().coerceAtLeast(0)
            if (activeSec >= MIN_SEGMENT_SECONDS && prevApp !in IGNORED_PACKAGES) {
                closedSegments.add(
                    Segment(
                        app = prevApp,
                        startedAtMs = openStartMs,
                        endedAtMs = now,
                        activeSeconds = activeSec,
                    )
                )
                _pendingSegmentCount.value = closedSegments.size
            }
        }

        // 开新 segment (但暂不入 closedSegments, 等下一次切走时再 finalize)
        openApp = packageName
        openStartMs = now
        _foregroundApp.value = if (packageName in IGNORED_PACKAGES) null else packageName
    }

    /** 取走所有已 close 的 segments + 把当前 open 的 "切片" (一段从 openStart 到 now 的子段)
     *  也一起带出去, 同时把 openStart 重置为 now (segment 继续, 但起点更新).
     *  保证: 每分钟使用都被精确统计, 不丢. */
    @Synchronized
    fun drainSegments(): List<Segment> {
        val now = System.currentTimeMillis()
        val out = ArrayList(closedSegments)
        closedSegments.clear()

        // 当前 open app 也切一片
        openApp?.let { app ->
            if (app !in IGNORED_PACKAGES) {
                val activeSec = ((now - openStartMs) / 1000).toInt().coerceAtLeast(0)
                if (activeSec >= MIN_SEGMENT_SECONDS) {
                    out.add(
                        Segment(
                            app = app,
                            startedAtMs = openStartMs,
                            endedAtMs = now,
                            activeSeconds = activeSec,
                        )
                    )
                }
            }
            openStartMs = now // 重置, 下次再切一刀
        }
        _pendingSegmentCount.value = 0
        return out
    }

    /** AccessibilityService 断了 (用户关无障碍 / 系统重启 service) → 重置. */
    @Synchronized
    fun reset() {
        closedSegments.clear()
        openApp = null
        openStartMs = 0L
        _foregroundApp.value = null
        _pendingSegmentCount.value = 0
    }

    private const val MIN_SEGMENT_SECONDS = 2
}
