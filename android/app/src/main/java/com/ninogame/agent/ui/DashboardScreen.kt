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
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.ninoSettings
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
    val agentToken by settings.agentToken.collectAsState(initial = null)
    val deviceId by settings.deviceId.collectAsState(initial = null)
    val childId by settings.childId.collectAsState(initial = null)

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

            // 状态卡: 当前是否已配对 + 连接 backend
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                ),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.Link,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                        Spacer(Modifier.height(0.dp))
                        Text(
                            text = "  " + stringResource(R.string.dash_status_paired),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
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

            // Stage 1 占位 — Stage 2 替换为余额 / 模式 / 事件
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "余额 + 模式 + 实时事件",
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
