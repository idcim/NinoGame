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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.CloudQueue
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ninogame.agent.BuildConfig
import com.ninogame.agent.R
import com.ninogame.agent.net.WsClient
import com.ninogame.agent.ninoSettings
import com.ninogame.agent.service.AgentState
import kotlinx.coroutines.launch

/** 设置页 — v0.5.15 拆 Dashboard 出去, 把连接状态 + ID 摘要 + 重新配对 + 关于
 *  这些"运维项"集中放这里. Dashboard 只保留"孩子日常用得到"的卡片 (余额/任务/申请).
 *
 *  入口: Dashboard 顶部右上角 ⚙ 按钮.
 *
 *  内容:
 *    - 连接状态 (WS Open / Connecting / Disconnected / Failed)
 *    - 后端 URL + Child / Device ID 摘要
 *    - 应用版本
 *    - 关于我们 (打开 AboutDialog)
 *    - 重新配对 (PIN 已设时先验证, 跟原 Dashboard 行为一致)
 */
@Composable
fun SettingsScreen(
    windowSize: WindowSizeClass,
    onBack: () -> Unit,
    onResetPair: () -> Unit,
    onOpenChangelog: () -> Unit,
    onOpenMessages: () -> Unit = {},
    onOpenLedger: () -> Unit = {},
) {
    val settings = ninoSettings
    val scope = rememberCoroutineScope()
    val backendUrl by settings.backendUrl.collectAsState(initial = null)
    val deviceId by settings.deviceId.collectAsState(initial = null)
    val childId by settings.childId.collectAsState(initial = null)
    val pinIsSet by settings.pinIsSet.collectAsState(initial = false)
    val connState by AgentState.connection.collectAsState()

    var showAbout by remember { mutableStateOf(false) }
    var showPinDialog by remember { mutableStateOf(false) }

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
                .padding(PaddingValues(horizontal = 16.dp, vertical = 16.dp)),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // 头部: 返回 + logo + 标题
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 4.dp),
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = null)
                }
                Image(
                    painter = painterResource(id = R.mipmap.ic_launcher),
                    contentDescription = null,
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)),
                )
                Text(
                    "  " + stringResource(R.string.settings_title),
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Bold,
                )
            }

            // 连接状态卡
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                ),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ConnectionRow(connState)
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

            // 版本卡
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.padding(16.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(0.dp))
                    Column(modifier = Modifier.padding(start = 12.dp)) {
                        Text(
                            stringResource(R.string.settings_version_label),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "v${BuildConfig.VERSION_NAME}",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }

            // v0.5.25+ 我的消息 (通知历史)
            OutlinedButton(
                onClick = onOpenMessages,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Info, contentDescription = null)
                Text("  我的消息")
            }

            // v0.5.25+ Token 变动 (ledger 历史)
            OutlinedButton(
                onClick = onOpenLedger,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Info, contentDescription = null)
                Text("  Token 变动")
            }

            // 更新日志
            OutlinedButton(
                onClick = onOpenChangelog,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Info, contentDescription = null)
                Text("  " + stringResource(R.string.changelog_title))
            }

            // 关于我们
            OutlinedButton(
                onClick = { showAbout = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Info, contentDescription = null)
                Text("  " + stringResource(R.string.dash_about_button))
            }

            // 重新配对 (PIN 防护)
            OutlinedButton(
                onClick = {
                    if (pinIsSet) {
                        showPinDialog = true
                    } else {
                        scope.launch {
                            settings.clearPairing()
                            onResetPair()
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Refresh, contentDescription = null)
                Text("  " + stringResource(R.string.dash_reset_pair))
            }
        }
    }

    if (showAbout) {
        AboutDialog(
            onDismiss = { showAbout = false },
            onOpenChangelog = onOpenChangelog,
        )
    }

    if (showPinDialog) {
        PinDialog(
            onDismiss = { showPinDialog = false },
            onSuccess = {
                showPinDialog = false
                scope.launch {
                    settings.clearPairing()
                    onResetPair()
                }
            },
        )
    }
}

/** WS 状态行 — 跟原 Dashboard ConnectionBadge 等价, 但放在 Settings 而不是首页. */
@Composable
private fun ConnectionRow(state: WsClient.ConnectionState) {
    val (icon, color, label) = when (state) {
        is WsClient.ConnectionState.Open -> Triple(
            Icons.Filled.CloudDone,
            MaterialTheme.colorScheme.secondary,
            stringResource(R.string.conn_open),
        )
        is WsClient.ConnectionState.Connecting -> Triple(
            Icons.Filled.CloudQueue,
            MaterialTheme.colorScheme.error,
            stringResource(R.string.conn_connecting),
        )
        is WsClient.ConnectionState.Disconnected -> Triple(
            Icons.Filled.CloudOff,
            MaterialTheme.colorScheme.onPrimaryContainer,
            stringResource(R.string.conn_disconnected),
        )
        is WsClient.ConnectionState.Failed -> Triple(
            Icons.Filled.CloudOff,
            MaterialTheme.colorScheme.error,
            stringResource(R.string.conn_failed),
        )
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = color)
        Text(
            "  $label",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = color,
        )
    }
}
