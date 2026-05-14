package com.ninogame.agent.service

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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
        ForegroundAppMonitor.setForeground(pkg)

        // v0.5.16+ Token 耗尽 + 当前不是自家 App + 是 consumption 类 →
        // 把孩子从游戏赶回桌面 + 短促通知 (跟 Windows agent OOT focus reclaim 等价).
        // 非 consumption (笔记 / 浏览器 / 学习类 / 系统 launcher) 不打扰.
        // 我们 App 自己的 pkg 不拦 — 孩子在 OOT overlay 上选三按钮要能动.
        if (AgentState.outOfToken.value && pkg != packageName) {
            val category = CategoryCache.getCategory(pkg)
            if (category == "consumption") {
                Log.i(TAG, "out-of-token + foreground=$pkg (consumption) → home")
                BlockNotifier.notifyOutOfToken(this, pkg)
                performGlobalAction(GLOBAL_ACTION_HOME)
                return  // 不再跑规则匹配, 已经赶回 home 了
            }
        }

        // v0.5.4+ Stage 3a: 跑规则引擎 — 命中就执行 action + 上报 block 事件
        val hits = RuleEngine.match(pkg)
        if (hits.isEmpty()) return
        for (hit in hits) {
            handleHit(pkg, hit)
        }
    }

    private fun handleHit(pkg: String, hit: RuleEngine.Hit) {
        Log.i(TAG, "rule hit: pkg=$pkg rule=${hit.rule.name} action=${hit.rule.spec.action.type}")
        val action = hit.rule.spec.action.type
        when (action) {
            "kill_and_warn" -> {
                BlockNotifier.notifyBlocked(this, hit.rule, pkg)
                performGlobalAction(GLOBAL_ACTION_HOME)
            }
            "kill_silent" -> {
                performGlobalAction(GLOBAL_ACTION_HOME)
            }
            "warn_only" -> {
                BlockNotifier.notifyBlocked(this, hit.rule, pkg)
            }
            else -> {
                Log.w(TAG, "unknown action type: $action")
            }
        }
        // 上报 block 事件 — 跟 Windows agent 协议一致, server publishToParent 让
        // 家长后台事件流立刻能看到 (跟 EventFeed 一致)
        AgentService.sendEvent("block", buildJsonObject {
            put("rule_id", hit.rule.id)
            put("rule_name", hit.rule.name)
            put("process_name", pkg)
            put("matched_value", hit.matchedValue)
            put("action", action)
        })
    }

    override fun onInterrupt() {
        // System will call this to interrupt our service; just no-op
        Log.i(TAG, "onInterrupt")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        Log.i(TAG, "onUnbind — 无障碍权限被关")
        // v0.5.12+ 立刻上报 server, 让家长后台 EventFeed 实时看到 "孩子关了无障碍"
        // (跟 Windows agent watchdog 死告警 / pin_fail 上报 等价). server 端 onEvent
        // 落 events 表 + publishToParent + 触发 notifier (企微/SMTP) 推家长.
        AgentService.sendEvent("accessibility_disabled", buildJsonObject {
            put("ts", System.currentTimeMillis())
        })
        ForegroundAppMonitor.reset()
        return super.onUnbind(intent)
    }

    companion object {
        private const val TAG = "NinoA11y"
    }
}
