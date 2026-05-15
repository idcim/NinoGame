package com.ninogame.agent.service

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
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

    /** 静态硬编码黑名单 — 自家 app + 常见系统 / launcher / IME / 系统 UI 包名.
     *  仅作 fallback: 真正生效的 [ignoredPackages] 在 [discoverIgnoredPackages] 里
     *  叠加 PackageManager 运行时发现的 launcher (CATEGORY_HOME) + IME 列表 +
     *  系统 UI, 涵盖 Pixel `com.google.android.apps.nexuslauncher` / 三星 OneUI /
     *  小米 / 华为 / OPPO / vivo 等 OEM 启动器 + 第三方 (Nova/Microsoft Launcher).
     *
     *  之前只有静态列表, Pixel launcher (com.google.android.apps.nexuslauncher)
     *  漏写, 导致用户回桌面时 TokenTicker 仍然扣分 — 这次彻底改成运行时发现。 */
    private val STATIC_IGNORED = setOf(
        "com.ninogame.agent",
        "com.ninogame.agent.debug",
        "android",
        "com.android.systemui",
        // 常见 launcher (运行时发现失败时的 fallback)
        "com.android.launcher",
        "com.android.launcher3",
        "com.google.android.apps.nexuslauncher",      // Pixel 默认 launcher
        "com.miui.home",                              // MIUI
        "com.huawei.android.launcher",                // EMUI
        "com.hihonor.android.launcher",               // 荣耀 MagicOS
        "com.oppo.launcher",                          // ColorOS
        "com.oneplus.launcher",                       // 一加 OxygenOS
        "com.vivo.launcher",                          // OriginOS / FuntouchOS
        "com.sec.android.app.launcher",               // 三星 OneUI
        "com.realme.launcher",                        // realmeUI
        "com.android.quickstep",                      // 系统手势导航
    )

    /** 实际生效的 IGNORED 集合 — STATIC_IGNORED ∪ 运行时发现的 launcher/IME/...
     *  线程安全用 @Volatile + 整体替换; setForeground / drainSegments 都用快照读. */
    @Volatile
    private var ignoredPackages: Set<String> = STATIC_IGNORED

    @Synchronized
    fun setForeground(packageName: String?) {
        if (packageName.isNullOrBlank()) return
        if (packageName == openApp) return // 同 app 内 Activity 切, 忽略
        val ignored = ignoredPackages
        // 不在 IGNORED 才进 unknown 分类队列, 否则会让自家 app + launcher 也被发 LLM
        if (packageName !in ignored) {
            CategoryCache.noteUnknown(packageName)
        }
        val now = System.currentTimeMillis()

        // 关掉当前 open segment
        openApp?.let { prevApp ->
            val activeSec = ((now - openStartMs) / 1000).toInt().coerceAtLeast(0)
            if (activeSec >= MIN_SEGMENT_SECONDS && prevApp !in ignored) {
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
        // launcher / IME / SystemUI 等系统类不参与 TokenTicker 扣分:
        // foregroundApp expose 成 null, TokenTicker 的 "no foreground app" 短路触发
        _foregroundApp.value = if (packageName in ignored) null else packageName
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
        val ignored = ignoredPackages
        openApp?.let { app ->
            if (app !in ignored) {
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

    /** AgentService.onCreate 调用一次: 查 PackageManager 找所有 launcher / IME /
     *  其它系统 UI 包名, 合并进 [ignoredPackages]. 后续 setForeground 看到这些 pkg
     *  时 expose null, TokenTicker 自然不扣.
     *
     *  这是修 v0.5.6 引入的 bug — 之前硬编码列表漏了 Pixel/三星/各种第三方 launcher,
     *  导致在桌面也扣分 (用户反馈"安卓端运行怎么不扣 token... 应该是不扣却扣了").
     *
     *  实际查询的类别:
     *    1. ACTION_MAIN + CATEGORY_HOME: 所有 launcher (官方 / OEM / 第三方均覆盖)
     *    2. queryIntentServices ACTION_INPUT_METHOD: 所有输入法
     *    3. 不再单查 SystemUI/Settings — 那些通过类型筛太宽, 留给 STATIC_IGNORED 兜底 */
    fun discoverIgnoredPackages(context: Context) {
        val pm = context.packageManager
        val merged = STATIC_IGNORED.toMutableSet()

        // launcher
        runCatching {
            val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            val launchers = pm.queryIntentActivities(homeIntent, PackageManager.MATCH_DEFAULT_ONLY)
            for (info in launchers) {
                info.activityInfo?.packageName?.let { merged.add(it) }
            }
            Log.i(TAG, "discovered ${launchers.size} launcher(s)")
        }.onFailure { Log.w(TAG, "launcher discovery failed", it) }

        // 输入法
        runCatching {
            val imeIntent = Intent("android.view.InputMethod")
            val imes = pm.queryIntentServices(imeIntent, 0)
            for (info in imes) {
                info.serviceInfo?.packageName?.let { merged.add(it) }
            }
            Log.i(TAG, "discovered ${imes.size} IME(s)")
        }.onFailure { Log.w(TAG, "IME discovery failed", it) }

        ignoredPackages = merged
        Log.i(TAG, "ignoredPackages now has ${merged.size} entries")
    }

    private const val MIN_SEGMENT_SECONDS = 2
    private const val TAG = "FgAppMonitor"
}
