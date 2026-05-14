package com.ninogame.agent.service

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

/** 国内 ROM 后台引导 — MIUI / EMUI / ColorOS / OriginOS 默认杀后台 Service,
 *  需要用户手动加 NinoGame 到自启动白名单 + 关电池优化才能保持监控.
 *  Stock Android / Google Pixel 一般不需要 (Dashboard 不显示引导).
 *
 *  CLAUDE.md §17.6 Stage 4 (国内 ROM 适配引导页) 落地. 设计:
 *    - RomDetector.detectVendor() 看 Build.MANUFACTURER / Build.BRAND
 *    - openAutostartSettings(ctx) 试一组厂商特定 Intent, 哪个能跳哪个; 全失败兜底
 *      到 App 信息页让用户手动找
 *    - isBatteryOptimizationIgnored(ctx) 查电池优化白名单 + requestIgnoreBatteryOpt(ctx)
 *      直接弹系统对话框 (跨 ROM 通用)
 */
object RomAutostartHelper {

    enum class Vendor { Xiaomi, Huawei, Oppo, Vivo, OnePlus, Meizu, Stock }

    fun detectVendor(): Vendor {
        val mfr = Build.MANUFACTURER.lowercase()
        val brand = Build.BRAND.lowercase()
        return when {
            mfr.contains("xiaomi") || brand.contains("xiaomi") ||
                brand.contains("redmi") || brand.contains("poco") -> Vendor.Xiaomi
            mfr.contains("huawei") || brand.contains("huawei") ||
                brand.contains("honor") -> Vendor.Huawei
            mfr.contains("oppo") || brand.contains("oppo") ||
                brand.contains("realme") -> Vendor.Oppo
            mfr.contains("vivo") || brand.contains("vivo") -> Vendor.Vivo
            mfr.contains("oneplus") || brand.contains("oneplus") -> Vendor.OnePlus
            mfr.contains("meizu") || brand.contains("meizu") -> Vendor.Meizu
            else -> Vendor.Stock
        }
    }

    /** 是否是需要后台白名单引导的 ROM (Stock Android 跳过). */
    fun needsAutostartGuide(): Boolean = detectVendor() != Vendor.Stock

    /** 试跳厂商自启动管理页. 第一个能起来的成功; 全失败兜底到 App 信息页. */
    fun openAutostartSettings(ctx: Context): Boolean {
        val candidates = when (detectVendor()) {
            Vendor.Xiaomi -> listOf(
                ComponentName("com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                ComponentName("com.miui.securitycenter",
                    "com.miui.powercenter.PowerSettings"),
            )
            Vendor.Huawei -> listOf(
                ComponentName("com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                ComponentName("com.huawei.systemmanager",
                    "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
            )
            Vendor.Oppo -> listOf(
                ComponentName("com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                ComponentName("com.coloros.oppoguardelf",
                    "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
                ComponentName("com.oplus.battery",
                    "com.oplus.powermanager.fuelgaue.PowerConsumptionActivity"),
            )
            Vendor.Vivo -> listOf(
                ComponentName("com.iqoo.secure",
                    "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
                ComponentName("com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
            )
            Vendor.OnePlus -> listOf(
                ComponentName("com.oneplus.security",
                    "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
            )
            Vendor.Meizu -> listOf(
                ComponentName("com.meizu.safe",
                    "com.meizu.safe.permission.SmartBGActivity"),
            )
            Vendor.Stock -> emptyList()
        }
        for (cn in candidates) {
            runCatching {
                val i = Intent().apply {
                    component = cn
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                ctx.startActivity(i)
                Log.i(TAG, "opened autostart settings: $cn")
                return true
            }.onFailure { Log.d(TAG, "intent $cn failed: ${it.message}") }
        }
        // 兜底: 跳 App 详情 (用户手动找电池 / 自启动)
        return openAppDetails(ctx)
    }

    fun isBatteryOptimizationIgnored(ctx: Context): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    /** 弹系统标准对话框请求"忽略电池优化". 用户点同意后回流到自家进程. */
    fun requestIgnoreBatteryOpt(ctx: Context): Boolean {
        // ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 直接弹同意对话框 — 比跳设置页快;
        // 但有的 ROM 隐藏了, 失败就跳列表页
        return runCatching {
            val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${ctx.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(i)
            true
        }.getOrElse {
            runCatching {
                ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
                true
            }.getOrDefault(false)
        }
    }

    private fun openAppDetails(ctx: Context): Boolean = runCatching {
        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${ctx.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        true
    }.getOrDefault(false)

    private const val TAG = "RomAutostartHelper"
}
