package com.ninogame.agent.service

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.ninogame.agent.data.Settings
import java.util.concurrent.TimeUnit

/** Watchdog 周期 Worker — 跟 Windows agent Watchdog.exe 等价的"自我恢复"机制.
 *
 *  孩子 / 国内 ROM 杀掉 AgentService 后, 系统会按 WorkManager 调度周期 (Android 强制
 *  最小 15min) 唤起这个 Worker 检查 — 检测到 AgentService 进程没在跑 + 已配对状态
 *  下, 重新 startForegroundService(AgentService). Watchdog 自己跟 Service 不同进程,
 *  孩子很难一次杀掉两个 (即使杀了 Service, WorkManager 仍能拉, 反之亦然).
 *
 *  Android 系统 WorkManager 自身**是不容易被杀的**: AlarmManager + 系统级调度,
 *  不依赖应用进程; 国内 ROM 也基本尊重 (清后台不影响 WorkManager).
 *
 *  Watchdog 不直接发 server 事件 — wsClient 跟 AgentService 同进程, Service 没在跑
 *  时 Watchdog 拿不到; 启动 Service 后 onHello 自然让 server 看到 "device 又上线了".
 *  服务端 last_seen_at gap >10min 已经有 device_offline_alerter 触发推送 (v0.4.1).
 */
class WatchdogWorker(
    ctx: Context,
    params: WorkerParameters,
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val paired = runCatching { Settings.from(applicationContext).isPairedNow() }
            .getOrDefault(false)
        if (!paired) {
            Log.d(TAG, "watchdog: 未配对, 跳过")
            return Result.success()
        }
        val running = isAgentServiceRunning(applicationContext)
        if (!running) {
            Log.w(TAG, "★ watchdog: AgentService 没在跑, 立刻拉起")
            AgentService.start(applicationContext)
        } else {
            Log.d(TAG, "watchdog: AgentService alive")
        }
        return Result.success()
    }

    @Suppress("DEPRECATION") // getRunningServices 在 API 26+ 受限但仍能拿自家进程的
    private fun isAgentServiceRunning(ctx: Context): Boolean {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        // 拿自家进程的运行 service 列表 (系统不让看别家的, 自家无限制)
        val services = am.getRunningServices(Int.MAX_VALUE) ?: return false
        val targetName = AgentService::class.java.name
        return services.any { it.service.className == targetName }
    }

    companion object {
        private const val TAG = "WatchdogWorker"
        private const val WORK_NAME = "ninogame_watchdog"
        // 15min 是 WorkManager 强制最小周期 (Android API 约束). 更短跑不了.
        private const val PERIOD_MIN: Long = 15

        /** NinoApp.onCreate 调一次 — KEEP policy 不重复调度, 重启 App 也只一份. */
        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<WatchdogWorker>(
                PERIOD_MIN, TimeUnit.MINUTES,
            ).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                req,
            )
            Log.i(TAG, "scheduled (period=${PERIOD_MIN}min)")
        }

        /** 解配对时调 — 没必要再让 Watchdog 一直 ping. */
        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME)
            Log.i(TAG, "cancelled")
        }
    }
}
