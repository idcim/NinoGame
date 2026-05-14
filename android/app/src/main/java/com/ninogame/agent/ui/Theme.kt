package com.ninogame.agent.ui

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/** NinoGame Android 配色 — 严格对齐 Windows agent (agent/ui/panel.py 等) +
 *  parent frontend Tailwind brand. 三端同一套 hex.
 *
 *  v0.5.15: 之前用了 Material 3 royal blue (#3563E6), 跟 agent/frontend 的
 *  品牌青蓝 (#1ea7c4) 完全不同色相 — 用户反馈"颜色和 PC 不一致". 改齐.
 *
 *  也取消 dynamicColor (Material You) — 之前的动态取色会让品牌色被 OEM 主题盖掉,
 *  孩子设备从米家蓝跳到 OPPO 绿, 视觉认知不稳; NinoGame 是品牌强的工具 App,
 *  品牌色稳定优先于 Material You "顺眼". 跟 Windows agent 用静态品牌色一致.
 */

// ── 品牌色 (跟 agent/ui/panel.py 同源) ──────────────────────────
private val Brand500 = Color(0xFF1EA7C4)  // 主品牌色 (Tailwind brand-500)
private val Brand400 = Color(0xFF3EAEC2)
private val Brand600 = Color(0xFF1789A3)  // Hover
private val Brand700 = Color(0xFF176E83)
private val Brand50 = Color(0xFFF0F9FB)
private val Accent500 = Color(0xFF66C596)  // 学习类 / 成功绿
private val Accent600 = Color(0xFF4EB280)
private val Warn500 = Color(0xFFD96A3C)   // 警告 / 警示橙
private val Warn600 = Color(0xFFB95A30)
private val Ink900 = Color(0xFF1A3140)    // 主文本
private val Ink600 = Color(0xFF6F8590)    // 次要文本
private val Ink400 = Color(0xFFA9B9C3)    // 弱化文本
private val Bg = Color(0xFFF5F9FB)        // 页面背景
private val Card = Color(0xFFFFFFFF)      // 卡片背景
private val Border = Color(0xFFDBE5EB)

private val LightColors = lightColorScheme(
    primary = Brand500,
    onPrimary = Color.White,
    primaryContainer = Brand50,
    onPrimaryContainer = Brand700,
    secondary = Accent500,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE9F5EE),
    onSecondaryContainer = Accent600,
    tertiary = Brand600,
    onTertiary = Color.White,
    error = Warn500,
    onError = Color.White,
    errorContainer = Color(0xFFFDECDF),
    onErrorContainer = Warn600,
    background = Bg,
    onBackground = Ink900,
    surface = Card,
    onSurface = Ink900,
    surfaceVariant = Color(0xFFEDF3F6),
    onSurfaceVariant = Ink600,
    outline = Border,
    outlineVariant = Color(0xFFE8EFF3),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF6FC7D8),         // brand-300 提亮
    onPrimary = Color(0xFF0B2530),
    primaryContainer = Color(0xFF185B6C), // brand-800 深色容器
    onPrimaryContainer = Brand50,
    secondary = Color(0xFF8FD4B0),
    onSecondary = Color(0xFF0E2A1A),
    error = Color(0xFFE89070),
    onError = Color(0xFF2C1208),
    background = Color(0xFF0E1F26),
    onBackground = Color(0xFFE3ECF0),
    surface = Color(0xFF142A33),
    onSurface = Color(0xFFE3ECF0),
    surfaceVariant = Color(0xFF1E3540),
    onSurfaceVariant = Color(0xFFB8C7CF),
    outline = Color(0xFF3D5663),
)

@Composable
fun NinoTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }
    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}
