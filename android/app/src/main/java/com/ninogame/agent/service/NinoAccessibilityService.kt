package com.ninogame.agent.service

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.ninogame.agent.MainActivity
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
        instance = this  // 静态引用让 UI (OutOfTokenScreen "锁屏休息") 能调 lockScreenNow
        // 启动一次 reset 防止上次进程残留状态
        ForegroundAppMonitor.reset()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString()
        if (pkg.isNullOrBlank()) return
        ForegroundAppMonitor.setForeground(pkg)

        // v0.5.19+ Token 耗尽 = 真"全屏锁": 任何非自家 + 非系统 passthrough 的前台
        // 都强拉 NinoGame MainActivity 回前台 (跟 Windows agent OOT focus reclaim 等价).
        // v0.5.21+: Lock 模式同样的强拉机制 — 孩子按"锁屏休息"后切 app 也被拉回.
        //
        // 系统 passthrough 例外 (isSystemPassthrough): 系统 UI / IME / 拨号 / 通讯录 —
        // 让孩子在锁屏状态下还能用紧急通话、状态栏通知, 跟 OS 紧急 SOS 同思路.
        //
        // 孩子的合法出路:
        //   1. 申请游戏时间 → server 推家长审批 → balance>0 → 解锁
        //   2. 家长 PIN 解锁 → Parent mode → 不扣 token
        //   3. 等家长在后台或 ModeAndFreePassCard 上把模式切回 Child
        val isLocked = AgentState.outOfToken.value || AgentState.mode.value == AgentState.Mode.Lock
        if (isLocked && pkg != packageName) {
            if (!isSystemPassthrough(pkg)) {
                Log.i(TAG, "locked (oot=${AgentState.outOfToken.value} mode=${AgentState.mode.value}) + foreground=$pkg → relaunch NinoGame")
                BlockNotifier.notifyOutOfToken(this, pkg)
                launchSelfToFront()
                return  // 不再跑规则匹配, 已经强制拉回自家了
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

    /** 把 NinoGame MainActivity 强拉到前台 — outOfToken 全屏锁的"反弹"动作. */
    private fun launchSelfToFront() {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        runCatching { startActivity(intent) }
            .onFailure { Log.w(TAG, "launchSelfToFront failed", it) }
    }

    /** 系统级 passthrough 包 — outOfToken 时这些前台**不**触发反弹.
     *  保留:
     *    - "android" / "com.android.systemui": 系统事件 / 状态栏 / 通知抽屉
     *    - 输入法 (pkg.contains("inputmethod")): PIN 验证要用键盘
     *    - 拨号 / 电话 / 通讯录: 紧急通话不能被锁屏拦截 (跟 OS 紧急 SOS 同思路;
     *      家长不想这样可以远程加规则拦"com.android.dialer")
     *  桌面 launcher **不在**这里, OOT 时也会被强拉回 (跟"全屏锁"语义一致). */
    private fun isSystemPassthrough(pkg: String): Boolean {
        if (pkg == "android" || pkg == "com.android.systemui") return true
        if (pkg.contains("inputmethod", ignoreCase = true)) return true
        if (pkg.contains("dialer", ignoreCase = true)) return true
        if (pkg == "com.android.phone" || pkg == "com.android.contacts") return true
        if (pkg.contains("emergency", ignoreCase = true)) return true
        return false
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

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "NinoA11y"

        /** 当前 service 实例的弱反向引用. UI 调 [lockScreenNow] 时通过这个找 service.
         *  Service 没起或被系统杀掉时 null, 调用方应该 fallback (短期降级为 Home + 通知). */
        @Volatile
        private var instance: NinoAccessibilityService? = null

        /** 触发系统级锁屏 — GLOBAL_ACTION_LOCK_SCREEN (API 28+).
         *  跟孩子按手机电源键效果一致: 屏幕熄灭, 解锁要 OS PIN/指纹.
         *  解锁后系统回到锁屏前的前台 (NinoGame). 加上 Lock 模式强拉机制,
         *  孩子解锁系统屏幕后切到任何 app 都会被拉回 NinoGame Lock 锁屏页.
         *
         *  返回:
         *    - true: 成功触发
         *    - false: service 未启用或 OS 版本太老 (<API 28) — 调用方应 fallback */
        fun lockScreenNow(): Boolean {
            val svc = instance ?: return false
            return runCatching {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                    svc.performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
                } else {
                    // API 28 以下没 LOCK_SCREEN, 用 Home 退桌面兜底 (体验差一档)
                    svc.performGlobalAction(GLOBAL_ACTION_HOME)
                }
            }.getOrDefault(false)
        }
    }
}
