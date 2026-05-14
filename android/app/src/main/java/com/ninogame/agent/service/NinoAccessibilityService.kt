package com.ninogame.agent.service

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/** 监听前台窗口变化 — 跟 Windows Agent 的 EnumWindows + 前台进程检测等价.
 *
 *  Android 6.0+ 监前台 app 唯一合规途径就是无障碍服务 (`UsageStats` API 只能给
 *  使用统计, 抓不到实时 foreground). 缺点: 用户必须在系统设置里手动启用一次.
 *
 *  这版不做任何 UI 反馈 / 不读屏 / 不录入. 单纯把 onAccessibilityEvent 触发的
 *  packageName 喂给 [ForegroundAppMonitor] singleton, 让 UsageReporter 5min
 *  打一次包发 server.
 *
 *  Stage 3 会扩展: 命中规则的 package → 显式 performGlobalAction(GLOBAL_ACTION_HOME)
 *  把用户从被拦的 app "弹"回桌面 + 弹对话框告知 "不要玩这个". 跟 Windows kill 等价.
 */
class NinoAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "NinoAccessibilityService connected")
        // 启动一次 reset 防止上次进程残留状态
        ForegroundAppMonitor.reset()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString()
        if (pkg.isNullOrBlank()) return
        // Stage 2b 仅记录, 不拦截
        ForegroundAppMonitor.setForeground(pkg)
    }

    override fun onInterrupt() {
        // System will call this to interrupt our service; just no-op
        Log.i(TAG, "onInterrupt")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        Log.i(TAG, "onUnbind")
        ForegroundAppMonitor.reset()
        return super.onUnbind(intent)
    }

    companion object {
        private const val TAG = "NinoA11y"
    }
}
