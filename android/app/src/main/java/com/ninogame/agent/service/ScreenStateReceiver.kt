package com.ninogame.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 监屏幕 ON/OFF — screen-off 持续 [IDLE_LOCK_MINUTES] 分钟自动切 Lock 模式.
 *  跟 Windows agent "idle 10 min 自动 Lock" 等价 (CLAUDE.md §4.3).
 *
 *  Android 没法纯代码强制锁屏 (需要 Device Admin), 但切 Lock 模式让 TokenTicker
 *  停扣 + Dashboard 显示 Lock 模式徽章; 用户开屏后自动切回 Child (跟 Windows 同思路:
 *  锁是 token / 拦截层面的, 不是物理锁屏).
 *
 *  注意: Intent.ACTION_SCREEN_ON/OFF 这两个广播必须**运行时注册**, 不能在 Manifest
 *  里声明 (Android 安全限制). 由 AgentService.onCreate 注册, onDestroy 注销.
 */
class ScreenStateReceiver(private val scope: CoroutineScope) : BroadcastReceiver() {

    private var idleLockJob: Job? = null

    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_SCREEN_OFF -> onScreenOff()
            Intent.ACTION_SCREEN_ON -> onScreenOn()
            Intent.ACTION_USER_PRESENT -> onUserPresent()
        }
    }

    private fun onScreenOff() {
        // 从 AgentSettings 拿当前 idle_lock_minutes (server 推 settings_update 后即时生效)
        val mins = AgentSettings.current().idleLockMinutes.coerceIn(1L, 60L)
        Log.i(TAG, "screen off; arm idle-lock timer ${mins}min")
        idleLockJob?.cancel()
        idleLockJob = scope.launch {
            delay(mins * 60_000L)
            if (AgentState.mode.value != AgentState.Mode.Child) return@launch
            Log.i(TAG, "★ idle-lock fired → mode=Lock")
            AgentState.setMode(AgentState.Mode.Lock)
        }
    }

    private fun onScreenOn() {
        // 屏幕亮但还没解锁; idle-lock 计时取消, 等 USER_PRESENT 真正回 Child
        idleLockJob?.cancel()
        idleLockJob = null
        Log.d(TAG, "screen on; idle-lock cancelled")
    }

    private fun onUserPresent() {
        // 解锁屏幕 → 自动从 Lock 回 Child. server 推的 lock_device 命令导致的 Lock 也会被这个清掉,
        // 这是预期 — 家长重新远程 lock 可以再下发命令.
        if (AgentState.mode.value == AgentState.Mode.Lock) {
            Log.i(TAG, "user present + mode=Lock → restore Child")
            AgentState.setMode(AgentState.Mode.Child)
        }
    }

    companion object {
        private const val TAG = "ScreenStateReceiver"

        fun intentFilter(): IntentFilter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
    }
}
