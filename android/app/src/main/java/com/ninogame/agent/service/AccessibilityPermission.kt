package com.ninogame.agent.service

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.text.TextUtils

/** 检查 NinoAccessibilityService 是否已在系统设置里启用 + 一键跳系统设置.
 *
 *  Android API: 通过 `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`
 *  (string, 冒号分隔 ComponentName) + `Settings.Secure.ACCESSIBILITY_ENABLED`
 *  (int 0/1 总开关) 两个 setting 判定. 跟 AOSP / 各家 ROM 都一致.
 */
object AccessibilityPermission {

    private fun targetService(ctx: Context): ComponentName =
        ComponentName(ctx.applicationContext, NinoAccessibilityService::class.java)

    fun isEnabled(ctx: Context): Boolean {
        val expected = targetService(ctx).flattenToString()
        val master = Settings.Secure.getInt(
            ctx.contentResolver,
            Settings.Secure.ACCESSIBILITY_ENABLED,
            0,
        )
        if (master == 0) return false
        val enabled = Settings.Secure.getString(
            ctx.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        // 系统格式: "pkg/.SvcA:pkg2/.SvcB" — 拆分按冒号比对
        val splitter = TextUtils.SimpleStringSplitter(':').also { it.setString(enabled) }
        while (splitter.hasNext()) {
            val item = splitter.next()
            if (item.equals(expected, ignoreCase = true)) return true
            // 部分 ROM 用相对类名, 兼容两种形态
            val cn = ComponentName.unflattenFromString(item)
            if (cn?.packageName == ctx.packageName &&
                cn.className == NinoAccessibilityService::class.java.name
            ) return true
        }
        return false
    }

    fun openSettings(ctx: Context) {
        val i = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(i)
    }
}
