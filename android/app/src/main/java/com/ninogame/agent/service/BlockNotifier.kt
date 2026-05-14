package com.ninogame.agent.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.ninogame.agent.MainActivity
import com.ninogame.agent.R

/** 拦截命中后弹通知 — 高优先级 + 红色 + 短文本. 单独 channel "block" 跟 Service
 *  常驻通知 (channel "agent_service") 分开, 用户可以单独控制提醒强度.
 *
 *  防风暴: 同 pkg 5 秒内只弹一次 (内存 LRU). 但 home action 每次都执行.
 */
object BlockNotifier {

    private const val CHANNEL_ID = "block"
    private const val NOTIF_ID_BASE = 2000
    private const val DEDUPE_WINDOW_MS = 5_000L

    private val lastNotifMs = mutableMapOf<String, Long>()

    fun notifyBlocked(ctx: Context, rule: RulesCache.Rule, packageName: String) {
        val now = System.currentTimeMillis()
        synchronized(this) {
            val last = lastNotifMs[packageName]
            if (last != null && now - last < DEDUPE_WINDOW_MS) return
            lastNotifMs[packageName] = now
            // 清过期 (顺手维护)
            lastNotifMs.entries.removeAll { now - it.value > 60_000L }
        }

        ensureChannel(ctx)
        val pendingFlags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
        val openApp = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java),
            pendingFlags,
        )
        val message = rule.spec.action.message.ifBlank {
            ctx.getString(R.string.block_default_message, rule.name)
        }
        val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_warning) // Stage 4 换品牌图标
            .setContentTitle(ctx.getString(R.string.block_notif_title, rule.name))
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .build()
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // 用 pkg hash 当通知 id, 同 pkg 后续通知会覆盖前一条
        nm.notify(NOTIF_ID_BASE + (packageName.hashCode() and 0x0FFF), n)
    }

    /** v0.5.16+ Token 耗尽时孩子还在消费类前台 → 跟普通规则拦截共用通知通道,
     *  但文案不同 (强调"没 token 不是规则违反"). 同 pkg 5 秒去重. */
    fun notifyOutOfToken(ctx: Context, packageName: String) {
        val now = System.currentTimeMillis()
        synchronized(this) {
            val last = lastNotifMs["__oot__:$packageName"]
            if (last != null && now - last < DEDUPE_WINDOW_MS) return
            lastNotifMs["__oot__:$packageName"] = now
        }
        ensureChannel(ctx)
        val pendingFlags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
        val openApp = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java),
            pendingFlags,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(ctx.getString(R.string.oot_notif_title))
            .setContentText(ctx.getString(R.string.oot_notif_body))
            .setStyle(NotificationCompat.BigTextStyle().bigText(ctx.getString(R.string.oot_notif_body)))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .build()
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID_BASE + 0xFFF, n)  // 固定 id 让 OOT 通知聚合一条, 不刷屏
    }

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            ctx.getString(R.string.block_notif_channel),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = ctx.getString(R.string.block_notif_channel_desc)
        }
        nm.createNotificationChannel(ch)
    }
}
