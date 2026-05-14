package com.ninogame.agent.ui

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
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Accessibility
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.CloudQueue
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Warning
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.net.WsClient
import com.ninogame.agent.ninoSettings
import com.ninogame.agent.service.AccessibilityPermission
import com.ninogame.agent.service.AgentState
import com.ninogame.agent.service.ForegroundAppMonitor
import kotlinx.coroutines.launch

/** 主面板 — Stage 1 仅显示"已配对"状态 + agent_token / device_id / child_id 摘要.
 *  Stage 2 加: 实时 WS 连接状态、余额、当前模式、最近事件。
 */
@Composable
fun DashboardScreen(
    windowSize: WindowSizeClass,
    onResetPair: () -> Unit,
) {
    val settings = ninoSettings
    val scope = rememberCoroutineScope()
    val backendUrl by settings.backendUrl.collectAsState(initial = null)
    @Suppress("UNUSED_VARIABLE")
    val agentToken by settings.agentToken.collectAsState(initial = null)
    val deviceId by settings.deviceId.collectAsState(initial = null)
    val childId by settings.childId.collectAsState(initial = null)
    val cachedBalance by settings.cachedBalance.collectAsState(initial = null)

    // v0.5.1+ 实时状态 (Service 写, UI 读)
    val connState by AgentState.connection.collectAsState()
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
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                a11yEnabled = AccessibilityPermission.isEnabled(ctx)
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
            Text(
                stringResource(R.string.dash_title),
                style = MaterialTheme.typography.headlineMedium,
            )

            // v0.5.2+ 无障碍权限状态 — 没启用时高优先级提醒
            AccessibilityCard(
                enabled = a11yEnabled,
                onOpenSettings = { AccessibilityPermission.openSettings(ctx) },
            )

            // v0.5.5+ 模式徽章 + 限免倒计时
            if (mode != AgentState.Mode.Child || freePassUntilMs != null) {
                ModeAndFreePassCard(mode = mode, freePassUntilMs = freePassUntilMs)
            }

            // 实时连接状态 + 后端 + IDs
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                ),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ConnectionBadge(connState)
                    if (!backendUrl.isNullOrBlank()) {
                        Text(
                            "Backend: ${backendUrl!!}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                    if (!childId.isNullOrBlank()) {
                        Text(
                            "Child: ${childId!!.take(8)}…",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                    if (!deviceId.isNullOrBlank()) {
                        Text(
                            "Device: ${deviceId!!.take(8)}…",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
            }

            // 余额卡 — Service 收到 wallet_update 实时更新
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        stringResource(R.string.dash_balance_label),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        displayBalance?.toString() ?: "—",
                        style = MaterialTheme.typography.headlineLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    if (liveBalance == null && cachedBalance != null) {
                        Text(
                            "上次同步 (离线缓存)",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
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

            // 操作行
            OutlinedButton(
                onClick = {
                    scope.launch {
                        settings.clearPairing()
                        onResetPair()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Refresh, contentDescription = null)
                Text("  " + stringResource(R.string.dash_reset_pair))
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

/** 模式 + 限免活动卡 — 仅在非 Child 或限免活跃时显示, Child + 无限免时不占屏幕. */
@Composable
private fun ModeAndFreePassCard(
    mode: AgentState.Mode,
    freePassUntilMs: Long?,
) {
    val (modeLabel, modeColor) = when (mode) {
        AgentState.Mode.Lock -> stringResource(R.string.mode_lock) to Color(0xFFB91C1C)
        AgentState.Mode.Parent -> stringResource(R.string.mode_parent) to Color(0xFF334155)
        AgentState.Mode.Child -> stringResource(R.string.mode_child) to Color(0xFF16A34A)
    }
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
                    color = Color(0xFFF59E0B),
                )
                Text(
                    stringResource(R.string.dash_free_pass_remaining, remainingMin),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 无障碍权限状态卡 — 未启用时显示警告 + 跳系统设置按钮. */
@Composable
private fun AccessibilityCard(enabled: Boolean, onOpenSettings: () -> Unit) {
    val (icon, color, msg) = if (enabled) {
        Triple(
            Icons.Filled.Accessibility,
            Color(0xFF16A34A),
            stringResource(R.string.a11y_status_enabled),
        )
    } else {
        Triple(
            Icons.Filled.Warning,
            Color(0xFFF59E0B),
            stringResource(R.string.a11y_status_disabled),
        )
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (enabled) MaterialTheme.colorScheme.surface
            else Color(0xFFFEF3C7),
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
                    color = if (enabled) MaterialTheme.colorScheme.onSurface else Color(0xFF78350F),
                )
            }
            if (!enabled) {
                Text(
                    stringResource(R.string.a11y_explain),
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF78350F),
                )
                OutlinedButton(onClick = onOpenSettings, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.a11y_open_settings))
                }
            }
        }
    }
}

/** 连接状态徽章 — Open 绿点 / Connecting 黄环 / Disconnected 灰 / Failed 红. */
@Composable
private fun ConnectionBadge(state: WsClient.ConnectionState) {
    val (icon, color, label) = when (state) {
        is WsClient.ConnectionState.Open -> Triple(
            Icons.Filled.CloudDone,
            Color(0xFF16A34A),
            stringResource(R.string.conn_open),
        )
        is WsClient.ConnectionState.Connecting -> Triple(
            Icons.Filled.CloudQueue,
            Color(0xFFF59E0B),
            stringResource(R.string.conn_connecting),
        )
        is WsClient.ConnectionState.Disconnected -> Triple(
            Icons.Filled.CloudOff,
            MaterialTheme.colorScheme.onPrimaryContainer,
            stringResource(R.string.conn_disconnected),
        )
        is WsClient.ConnectionState.Failed -> Triple(
            Icons.Filled.CloudOff,
            Color(0xFFB91C1C),
            stringResource(R.string.conn_failed),
        )
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = color)
        Spacer(Modifier.height(0.dp))
        Text(
            text = "  $label",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = color,
        )
    }
}

