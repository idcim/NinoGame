package com.ninogame.agent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.service.AgentService
import com.ninogame.agent.service.AgentSettings

/** 申请游戏时间 — 自然语言输入对话框. CLAUDE.md §13.1 申请-审批主流程的客户端入口.
 *
 *  Send 之后 dialog 关; 顶层 Snackbar 反馈成功/失败. 失败时(未联机/未配对/网络)
 *  错误消息直接给用户看 — 跟 Windows agent ui/request_dialog.py 一致.
 *
 *  Server 批准后会通过 command channel push temporary_unlock, AgentService 已经在
 *  Stage 3b1 接好, 自动放行规则 + 通知"家长放行了"; 拒绝则 server 通过另一条
 *  事件流通知 (frontend 端家长看到, Android 端孩子目前 v0.5.7 不显示 rejection,
 *  Stage 3c+ 加 reject_request command).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RequestDialog(
    onDismiss: () -> Unit,
    onResult: (ok: Boolean, message: String?) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val settings by AgentSettings.state.collectAsState()
    val quickOptions = settings.requestQuickOptions

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.request_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.request_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                // 快捷选项 chips — settings.request_quick_options. 点 chip 把内容填进
                // TextField, 孩子小不会打字也能申请. 家长后台 /child-settings 可改.
                if (quickOptions.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        for (opt in quickOptions) {
                            AssistChip(
                                onClick = { if (!sending) text = opt },
                                label = { Text(opt, style = MaterialTheme.typography.bodySmall) },
                            )
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text(stringResource(R.string.request_text_label)) },
                    placeholder = { Text(stringResource(R.string.request_placeholder)) },
                    minLines = 3,
                    maxLines = 5,
                    enabled = !sending,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    sending = true
                    val (ok, err) = AgentService.sendUnlockRequest(text.trim())
                    sending = false
                    onResult(ok, err)
                    if (ok) onDismiss()
                },
                enabled = !sending && text.isNotBlank(),
            ) {
                Text(stringResource(R.string.request_send))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !sending) {
                Text(stringResource(R.string.dialog_cancel))
            }
        },
    )
}
