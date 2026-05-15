package com.ninogame.agent.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Accessibility
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.ninoSettings
import com.ninogame.agent.service.AccessibilityPermission
import com.ninogame.agent.service.AgentState
import com.ninogame.agent.service.ForegroundAppMonitor
import com.ninogame.agent.service.RomAutostartHelper
import kotlinx.coroutines.launch

/** 主面板 — Stage 1 仅显示"已配对"状态 + agent_token / device_id / child_id 摘要.
 *  Stage 2 加: 实时 WS 连接状态、余额、当前模式、最近事件。
 */
@Composable
fun DashboardScreen(
    windowSize: WindowSizeClass,
    onOpenTasks: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val settings = ninoSettings
    val scope = rememberCoroutineScope()
    val cachedBalance by settings.cachedBalance.collectAsState(initial = null)

    // v0.5.1+ 实时状态 (Service 写, UI 读)
    val liveBalance by AgentState.walletBalance.collectAsState()
    val rulesCount by AgentState.rulesCount.collectAsState()
    val foregroundApp by ForegroundAppMonitor.foregroundApp.collectAsState()
    val pendingSegments by ForegroundAppMonitor.pendingSegmentCount.collectAsState()
    val mode by AgentState.mode.collectAsState()
    val freePassUntilMs by AgentState.freePassUntilMs.collectAsState()

    // v0.5.7+ 申请游戏时间对话框 + Snackbar 反馈
    var showRequest by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }

    // 优先实时余额, 没收到就用 DataStore 缓存
    val displayBalance = liveBalance ?: cachedBalance

    // v0.5.2+ 无障碍权限实时检测 — 用户跳系统设置回来后状态自动刷新.
    // Settings.Secure 没 listener API, 老套路: onResume 重查一次.
    val ctx = LocalContext.current
    var a11yEnabled by remember { mutableStateOf(AccessibilityPermission.isEnabled(ctx)) }
    // v0.5.11+ ROM 后台引导 — 仅国内 ROM + 未 dismiss 时显示
    val romGuideDismissed by settings.romGuideDismissed.collectAsState(initial = false)
    var batteryOk by remember { mutableStateOf(RomAutostartHelper.isBatteryOptimizationIgnored(ctx)) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                a11yEnabled = AccessibilityPermission.isEnabled(ctx)
                batteryOk = RomAutostartHelper.isBatteryOptimizationIgnored(ctx)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val maxWidth = when (windowSize.widthSizeClass) {
        WindowWidthSizeClass.Compact -> Int.MAX_VALUE.dp
        else -> 720.dp
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .widthIn(max = maxWidth)
                .fillMaxWidth()
                .padding(PaddingValues(horizontal = 16.dp, vertical = 24.dp)),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // 头部: logo + 标题 + 右上角 ⚙ 设置入口 (连接状态/重新配对/关于 都在 Settings)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 4.dp).fillMaxWidth(),
            ) {
                Image(
                    painter = painterResource(id = com.ninogame.agent.R.mipmap.ic_launcher),
                    contentDescription = null,
                    modifier = Modifier
                        .size(48.dp)
                        .clip(RoundedCornerShape(12.dp)),
                )
                Text(
                    "  " + stringResource(R.string.dash_title),
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onOpenSettings) {
                    Icon(
                        Icons.Filled.Settings,
                        contentDescription = stringResource(R.string.dash_settings_button),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // v0.5.2+ 无障碍权限状态 — 没启用时高优先级提醒
            AccessibilityCard(
                enabled = a11yEnabled,
                onOpenSettings = { AccessibilityPermission.openSettings(ctx) },
            )

            // v0.5.11+ 国内 ROM 后台引导 — Stock Android / 已 dismiss / 电池已白名单 + 厂商未识别都不显示
            if (RomAutostartHelper.needsAutostartGuide() && !romGuideDismissed) {
                RomGuidanceCard(
                    vendor = RomAutostartHelper.detectVendor(),
                    batteryOk = batteryOk,
                    onOpenAutostart = { RomAutostartHelper.openAutostartSettings(ctx) },
                    onRequestBattery = { RomAutostartHelper.requestIgnoreBatteryOpt(ctx) },
                    onDismiss = {
                        scope.launch { settings.dismissRomGuide() }
                    },
                )
            }

            // v0.5.5+ 模式徽章 + 限免倒计时
            if (mode != AgentState.Mode.Child || freePassUntilMs != null) {
                ModeAndFreePassCard(mode = mode, freePassUntilMs = freePassUntilMs)
            }

            // 余额卡 — 数字加大居中, 跟孩子心智里"剩多少 token"对齐
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                ),
            ) {
                Column(
                    modifier = Modifier.padding(vertical = 20.dp, horizontal = 16.dp).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        stringResource(R.string.dash_balance_label),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    Text(
                        displayBalance?.toString() ?: "—",
                        style = MaterialTheme.typography.displayLarge,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        textAlign = TextAlign.Center,
                    )
                    if (liveBalance == null && cachedBalance != null) {
                        Text(
                            "上次同步 (离线缓存)",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f),
                        )
                    }
                }
            }

            // 规则数 — hello_ack / rules_update 后实时更新
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Shield,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.height(0.dp))
                    Column(modifier = Modifier.padding(start = 12.dp)) {
                        Text(
                            stringResource(R.string.dash_rules_count),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            rulesCount?.let {
                                stringResource(R.string.dash_rules_count_value, it)
                            } ?: "—",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }

            // v0.5.2+ 监控调试卡 — 当前前台 + 缓冲 segments (5min 后上报)
            if (a11yEnabled) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            stringResource(R.string.dash_foreground_now),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            foregroundApp ?: "—",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "${stringResource(R.string.dash_segments_pending)}: $pendingSegments",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Stage 路线提示
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        "Stage 2b 监前台已上线 · 拦截在 Stage 3",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        stringResource(R.string.dash_stage_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(0.dp))

            // v0.5.7+ 申请玩游戏 — 仅 Child 模式 + 已配对显示, lock/parent 不展示
            if (mode == AgentState.Mode.Child) {
                Button(
                    onClick = { showRequest = true },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Filled.Send, contentDescription = null)
                    Text("  " + stringResource(R.string.dash_request_button))
                }
            }

            // v0.5.8+ 任务清单 / 申报 (不论模式都可访问, 让孩子能勾责任清单 + 申报激励任务)
            OutlinedButton(
                onClick = onOpenTasks,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.dash_tasks_button))
            }
        }

        // SnackbarHost 浮在底部, 占用 Box 而不是 Column 区
        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
        ) { data -> Snackbar(snackbarData = data) }
    }

    if (showRequest) {
        RequestDialog(
            onDismiss = { showRequest = false },
            onResult = { ok, errMsg ->
                val msg = if (ok) ctx.getString(R.string.request_sent_ok)
                else (errMsg ?: "发送失败")
                scope.launch { snackbarHostState.showSnackbar(msg) }
            },
        )
    }
}

/** 国内 ROM 后台引导卡 (v0.5.11+) — MIUI/EMUI/ColorOS 等会杀后台 Service.
 *  仅识别到国内 ROM + 用户未 dismiss 时显示. */
@Composable
private fun RomGuidanceCard(
    vendor: RomAutostartHelper.Vendor,
    batteryOk: Boolean,
    onOpenAutostart: () -> Unit,
    onRequestBattery: () -> Unit,
    onDismiss: () -> Unit,
) {
    val vendorName = stringResource(when (vendor) {
        RomAutostartHelper.Vendor.Xiaomi -> R.string.vendor_xiaomi
        RomAutostartHelper.Vendor.Huawei -> R.string.vendor_huawei
        RomAutostartHelper.Vendor.Oppo -> R.string.vendor_oppo
        RomAutostartHelper.Vendor.Vivo -> R.string.vendor_vivo
        RomAutostartHelper.Vendor.OnePlus -> R.string.vendor_oneplus
        RomAutostartHelper.Vendor.Meizu -> R.string.vendor_meizu
        RomAutostartHelper.Vendor.Stock -> R.string.app_name
    })
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(R.string.rom_guide_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                stringResource(R.string.rom_guide_body, vendorName),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            OutlinedButton(onClick = onOpenAutostart, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.rom_guide_open_autostart))
            }
            if (!batteryOk) {
                OutlinedButton(onClick = onRequestBattery, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.rom_guide_request_battery))
                }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text(
                    stringResource(R.string.rom_guide_dismiss),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
        }
    }
}

/** 模式 + 限免活动卡 — 仅在非 Child 或限免活跃时显示, Child + 无限免时不占屏幕.
 *
 *  v0.5.21+: 非 Child 模式时加"切回孩子模式"按钮.
 *    - Parent → Child: 直接切, 不要 PIN (家长进 Parent 已经验过 PIN 了)
 *    - Lock → Child: 走 PinDialog 验证 (防孩子瞎按) */
@Composable
private fun ModeAndFreePassCard(
    mode: AgentState.Mode,
    freePassUntilMs: Long?,
) {
    val (modeLabel, modeColor) = when (mode) {
        AgentState.Mode.Lock -> stringResource(R.string.mode_lock) to MaterialTheme.colorScheme.error
        AgentState.Mode.Parent -> stringResource(R.string.mode_parent) to MaterialTheme.colorScheme.onSurfaceVariant
        AgentState.Mode.Child -> stringResource(R.string.mode_child) to MaterialTheme.colorScheme.secondary
    }
    var showPinForUnlock by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                stringResource(R.string.dash_mode_label_v2),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                modeLabel,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = modeColor,
            )
            if (freePassUntilMs != null) {
                val remainingMin = ((freePassUntilMs - System.currentTimeMillis()) / 60_000L)
                    .toInt().coerceAtLeast(0)
                Spacer(Modifier.height(4.dp))
                Text(
                    stringResource(R.string.dash_free_pass_active),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.error,
                )
                Text(
                    stringResource(R.string.dash_free_pass_remaining, remainingMin),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // 非 Child 模式: 加"还给孩子"按钮
            if (mode != AgentState.Mode.Child) {
                Spacer(Modifier.height(8.dp))
                val btnLabel = when (mode) {
                    AgentState.Mode.Parent -> stringResource(R.string.mode_switch_back_from_parent)
                    AgentState.Mode.Lock -> stringResource(R.string.mode_switch_back_from_lock)
                    else -> stringResource(R.string.mode_switch_back_to_child)
                }
                Button(
                    onClick = {
                        if (mode == AgentState.Mode.Parent) {
                            // Parent 模式: 家长自己点的, 直接切
                            AgentState.setMode(AgentState.Mode.Child)
                        } else {
                            // Lock 模式: 走 PIN 验证 (防孩子绕开)
                            showPinForUnlock = true
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(btnLabel)
                }
            }
        }
    }

    if (showPinForUnlock) {
        PinDialog(
            onDismiss = { showPinForUnlock = false },
            onSuccess = {
                showPinForUnlock = false
                AgentState.setMode(AgentState.Mode.Child)
            },
        )
    }
}

/** 无障碍权限状态卡 — 未启用时显示警告 + 跳系统设置按钮. */
@Composable
private fun AccessibilityCard(enabled: Boolean, onOpenSettings: () -> Unit) {
    val (icon, color, msg) = if (enabled) {
        Triple(
            Icons.Filled.Accessibility,
            MaterialTheme.colorScheme.secondary,
            stringResource(R.string.a11y_status_enabled),
        )
    } else {
        Triple(
            Icons.Filled.Warning,
            MaterialTheme.colorScheme.error,
            stringResource(R.string.a11y_status_disabled),
        )
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (enabled) MaterialTheme.colorScheme.surface
            else MaterialTheme.colorScheme.errorContainer,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = color)
                Spacer(Modifier.height(0.dp))
                Text(
                    text = "  $msg",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onErrorContainer,
                )
            }
            if (!enabled) {
                Text(
                    stringResource(R.string.a11y_explain),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                OutlinedButton(onClick = onOpenSettings, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.a11y_open_settings))
                }
            }
        }
    }
}

// v0.5.15: ConnectionBadge 移到 SettingsScreen.ConnectionRow — Dashboard 不再显示
// 连接状态卡片以简化孩子端 UI (孩子不需要看 backend URL / ID 等运维信息).

