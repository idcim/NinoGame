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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.CloudQueue
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Shield
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.net.WsClient
import com.ninogame.agent.ninoSettings
import com.ninogame.agent.service.AgentState
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

    // 优先实时余额, 没收到就用 DataStore 缓存
    val displayBalance = liveBalance ?: cachedBalance

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

            // Stage 路线提示
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        "Stage 2a 已联机 · 监控拦截在 Stage 2b+",
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

