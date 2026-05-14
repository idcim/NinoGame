package com.ninogame.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.ninogame.agent.data.Settings
import kotlinx.coroutines.runBlocking

/** 开机自启 — 孩子重启平板 / 关机过夜后, Agent 自动回来.
 *
 *  Android 10+ 对 background service 启动有严格限制, 但 BOOT_COMPLETED 触发的
 *  Foreground Service 在白名单, 允许直接 startForegroundService.
 *
 *  Manifest 已声明 RECEIVE_BOOT_COMPLETED 权限. receiver intent-filter
 *  exported=true (BOOT_COMPLETED 必须可被系统调起).
 *
 *  注意: 没配对的设备也注册了 receiver — 检测 isPaired=false 就跳过. AgentService.start
 *  调用 startForegroundService, Service onCreate 会自检 settings, 没 pair 就闲置在
 *  Disconnected 状态. 但这里短路一下省得起一个空 Service 通知占着.
 *
 *  onReceive 给的预算约 10 秒, runBlocking 读 DataStore 几 ms 足够.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED &&
            intent?.action != "android.intent.action.QUICKBOOT_POWERON" // MIUI / 部分 ROM 用这个
        ) {
            return
        }
        val paired = runCatching {
            runBlocking { Settings.from(context).isPairedNow() }
        }.getOrDefault(false)
        if (!paired) {
            Log.i(TAG, "boot: 未配对, 不启 Service")
            return
        }
        Log.i(TAG, "boot: 已配对, 启 AgentService")
        AgentService.start(context)
    }

    companion object { private const val TAG = "BootReceiver" }
}
