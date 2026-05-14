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
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.service.AgentService
import com.ninogame.agent.service.TasksCache
import kotlinx.coroutines.launch

/** 任务页 — 两段:
 *   - 责任清单 (responsibility): checkbox 行, 勾选发 checklist_tick event (§8.6)
 *   - 激励任务 (incentive): 点"申报"弹 dialog 写备注后发 task_claim WS msg (§8.3)
 *
 *  跟 Windows agent ui/tray_icon.py 同协议 (server 端 onTaskClaim + checklist_tick
 *  事件 upsert responsibility_checks).
 *
 *  注: responsibility 的勾选状态目前**只在内存** — Stage 3c 加 hello_ack.responsibility_today
 *  字段或 GET /api/responsibility-checks/today 让 Agent 重启后恢复本日勾选状态.
 *  现版本切到别的页面或重启 App 后再回来全是未勾, 但 server 端的 responsibility_checks
 *  表数据是对的, 家长后台看得准.
 */
@Composable
fun TasksScreen(
    windowSize: WindowSizeClass,
    onBack: () -> Unit,
) {
    val tasks by TasksCache.tasks.collectAsState()
    val responsibility = tasks.filter { it.category == "responsibility" }
    val incentive = tasks.filter { it.category == "incentive" }

    var claimingTask by remember { mutableStateOf<TasksCache.Task?>(null) }
    // v0.5.10+ 勾选状态从 TasksCache.responsibilityToday 拿 — server hello_ack
    // 携带本日已勾任务, 跨页面 / 进程重启都不会丢. 切日自动清.
    val checkedIds = TasksCache.responsibilityToday.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

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
            // 头部: 返回 + logo + 大字标题, 跟 Dashboard 视觉一致
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 4.dp),
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = null)
                }
                Image(
                    painter = painterResource(id = com.ninogame.agent.R.mipmap.ic_launcher),
                    contentDescription = null,
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)),
                )
                Spacer(Modifier.height(0.dp))
                Text(
                    "  " + stringResource(R.string.tasks_title),
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Bold,
                )
            }

            if (tasks.isEmpty()) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Text(
                        stringResource(R.string.tasks_empty),
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                return@Column
            }

            // 责任清单段
            if (responsibility.isNotEmpty()) {
                Text(
                    stringResource(R.string.tasks_section_responsibility),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                ElevatedCard(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(8.dp)) {
                        for (t in responsibility) {
                            val checked = checkedIds.value.contains(t.id)
                            ResponsibilityRow(
                                task = t,
                                checked = checked,
                                onToggle = {
                                    val newChecked = !checked
                                    // 乐观更新 — TasksCache 单点写, UI 通过 StateFlow 自动刷
                                    TasksCache.toggleResponsibilityLocal(t.id, newChecked)
                                    val ok = AgentService.sendChecklistTick(t.id, newChecked)
                                    if (!ok) {
                                        // 回滚
                                        TasksCache.toggleResponsibilityLocal(t.id, checked)
                                        scope.launch {
                                            snackbarHostState.showSnackbar("发送失败, WS 未连")
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
            }

            // 激励任务段
            if (incentive.isNotEmpty()) {
                Text(
                    stringResource(R.string.tasks_section_incentive),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                ElevatedCard(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(8.dp)) {
                        for (t in incentive) {
                            IncentiveRow(
                                task = t,
                                onClaim = { claimingTask = t },
                            )
                        }
                    }
                }
            }
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
        ) { data -> Snackbar(snackbarData = data) }
    }

    claimingTask?.let { task ->
        ClaimDialog(
            task = task,
            onDismiss = { claimingTask = null },
            onResult = { ok, errMsg ->
                val msg = if (ok) "已申报，等家长审批" else (errMsg ?: "失败")
                scope.launch { snackbarHostState.showSnackbar(msg) }
            },
        )
    }
}

@Composable
private fun ResponsibilityRow(
    task: TasksCache.Task,
    checked: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (checked) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
            contentDescription = null,
            tint = if (checked) Color(0xFF16A34A) else MaterialTheme.colorScheme.outline,
            modifier = Modifier.padding(end = 12.dp),
        )
        Text(
            task.name,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onToggle) {
            Text(if (checked) "取消" else "完成")
        }
    }
}

@Composable
private fun IncentiveRow(
    task: TasksCache.Task,
    onClaim: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                task.name,
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                "+${task.reward_tokens} token · ${verifLabel(task.verification)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Button(onClick = onClaim) {
            Text("申报")
        }
    }
}

private fun verifLabel(v: String): String = when (v) {
    "parent_approve" -> "需家长审批"
    "self_report" -> "自报为准"
    "auto" -> "自动判定"
    else -> v
}

@Composable
private fun ClaimDialog(
    task: TasksCache.Task,
    onDismiss: () -> Unit,
    onResult: (ok: Boolean, errMsg: String?) -> Unit,
) {
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("申报: ${task.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "申报后家长会看到你的备注. ${verifLabel(task.verification)}.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("备注 (选填)") },
                    placeholder = { Text("例: 写了 3 页数学作业") },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val (ok, err) = AgentService.sendTaskClaim(task.id, note.trim().ifBlank { null })
                    onResult(ok, err)
                    onDismiss()
                },
            ) {
                Text("发送")
            }
        },
        dismissButton = {
            OutlinedButton(onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}
