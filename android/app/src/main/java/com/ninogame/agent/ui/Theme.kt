package com.ninogame.agent.ui

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/** NinoGame 配色 — 跟 frontend Tailwind brand 大致对齐. */
private val LightColors = lightColorScheme(
    primary       = Color(0xFF3563E6),
    onPrimary     = Color.White,
    primaryContainer = Color(0xFFEEF4FF),
    onPrimaryContainer = Color(0xFF0F172A),
    secondary     = Color(0xFF16A34A),  // 学习/绿
    onSecondary   = Color.White,
    error         = Color(0xFFB91C1C),
    background    = Color(0xFFFFFFFF),
    onBackground  = Color(0xFF0F172A),
    surface       = Color(0xFFFFFFFF),
    onSurface     = Color(0xFF0F172A),
    surfaceVariant = Color(0xFFF1F5F9),
    onSurfaceVariant = Color(0xFF475569),
    outline       = Color(0xFFCBD5E1),
)

private val DarkColors = darkColorScheme(
    primary       = Color(0xFF7C9BFF),
    onPrimary     = Color(0xFF0F172A),
    primaryContainer = Color(0xFF1E293B),
    onPrimaryContainer = Color(0xFFEEF4FF),
    secondary     = Color(0xFF4ADE80),
    onSecondary   = Color(0xFF0F172A),
    background    = Color(0xFF0F172A),
    onBackground  = Color(0xFFF1F5F9),
    surface       = Color(0xFF1E293B),
    onSurface     = Color(0xFFF1F5F9),
    surfaceVariant = Color(0xFF334155),
    onSurfaceVariant = Color(0xFFCBD5E1),
    outline       = Color(0xFF475569),
)

@Composable
fun NinoTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    /** Android 12+ 动态取色 (Material You). 老设备落回静态配色. */
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val ctx = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
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
