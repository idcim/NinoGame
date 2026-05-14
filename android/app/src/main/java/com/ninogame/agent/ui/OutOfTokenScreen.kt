package com.ninogame.agent.ui

import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BatteryAlert
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.service.AgentState
import kotlinx.coroutines.launch

/** Token 耗尽锁屏覆盖 — 跟 Windows agent ui/out_of_token_dialog.py 同语义.
 *
 *  触发: AgentState.outOfToken == true (walletBalance≤0 + mode==Child + !free_pass).
 *  这是个**Composable overlay**, 不是独立 Activity — 由 MainActivity 顶层叠在
 *  NavHost 上, 占满全屏. 跟 Windows 的"全屏 frameless + 抢焦点" 不能完全 1:1
 *  (Android 普通 App 没有阻止 Home 键的合法办法 — 这是系统级权限), 不过:
 *
 *  - Overlay 拦住整个 App 触摸, 孩子在 App 里无法绕开
 *  - 按 Back / Home 会出 App, 但 NinoAccessibilityService 同时监 outOfToken:
 *    + foreground 是 consumption category → performGlobalAction(GLOBAL_ACTION_HOME)
 *    把孩子从游戏类应用赶回桌面, 配 BlockNotifier 通知
 *  - 持续通知栏提醒 "Token 用完了"
 *
 *  三按钮 (跟 Windows 同):
 *    1. 申请游戏时间 → 弹 RequestDialog (沿用 Dashboard 的)
 *    2. 家长 PIN 解锁 → 弹 PinDialog → onSuccess → AgentState.setMode(Parent)
 *       (Parent 模式不扣 token, outOfToken 自动 false, overlay 消失)
 *    3. 锁屏休息 → AgentState.setMode(Lock) + 退到 Home + 通知
 *       (Lock 模式不扣 token, outOfToken 自动 false, overlay 消失;
 *       孩子等 server 端发 wallet_update + 家长决定何时切回 Child)
 *
 *  Balance 回正 (server 推 wallet_update 带 balance > 0) → AgentState.outOfToken
 *  自动 false, overlay 自然消失. 跟 Windows main._on_token_replenished 等价.
 */
@Composable
fun OutOfTokenScreen(modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var showRequest by remember { mutableStateOf(false) }
    var showPin by remember { mutableStateOf(false) }
    val snackbar = remember { androidx.compose.material3.SnackbarHostState() }

    // 拦 Back 键 — overlay 显示期间不让退栈/退 App. 跟 Windows OOT closeEvent.ignore 等价.
    BackHandler(enabled = true) { /* swallow */ }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xCC000000)),  // 80% 黑半透蒙层, 跟 Windows COLOR_BG_OVERLAY 一致
        contentAlignment = Alignment.Center,
    ) {
        Card(
            modifier = Modifier
                .widthIn(max = 480.dp)
                .padding(24.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
            ) {
                // Header 红色警示条 — 跟 Windows OOT QFrame#header 红 banner 一致
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.error)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Image(
                        painter = painterResource(id = R.mipmap.ic_launcher),
                        contentDescription = null,
                        modifier = Modifier.size(24.dp).clip(RoundedCornerShape(6.dp)),
                    )
                    Text(
                        "  " + stringResource(R.string.oot_header),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = Color.White,
                    )
                }

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp, vertical = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(
                        Icons.Filled.BatteryAlert,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(48.dp),
                    )
                    Text(
                        stringResource(R.string.oot_title),
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        stringResource(R.string.oot_hint),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )

                    Spacer(Modifier.height(4.dp))

                    // 3 个按钮 — 跟 Windows OOT 三按钮顺序一致
                    Button(
                        onClick = { showRequest = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Filled.Send, contentDescription = null)
                        Text("  " + stringResource(R.string.oot_btn_request))
                    }

                    Button(
                        onClick = { showPin = true },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.tertiary,
                        ),
                    ) {
                        Icon(Icons.Filled.Lock, contentDescription = null)
                        Text("  " + stringResource(R.string.oot_btn_parent_unlock))
                    }

                    Button(
                        onClick = { doRest(ctx) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Icon(Icons.Filled.Bedtime, contentDescription = null)
                        Text("  " + stringResource(R.string.oot_btn_rest))
                    }
                }
            }
        }

        androidx.compose.material3.SnackbarHost(
            hostState = snackbar,
            modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
        )
    }

    if (showRequest) {
        RequestDialog(
            onDismiss = { showRequest = false },
            onResult = { ok, errMsg ->
                val msg = if (ok) ctx.getString(R.string.request_sent_ok)
                else (errMsg ?: "发送失败")
                scope.launch { snackbar.showSnackbar(msg) }
            },
        )
    }

    if (showPin) {
        PinDialog(
            onDismiss = { showPin = false },
            onSuccess = {
                showPin = false
                // 切 Parent 模式 — TokenTicker 第 1 个条件就跳过, 不再扣 token;
                // outOfToken 派生条件 mode==Child 失效 → overlay 自动消失
                AgentState.setMode(AgentState.Mode.Parent)
            },
        )
    }
}

/** "锁屏休息": 切 Lock 模式 + 退到桌面.
 *  Lock 模式让 outOfToken 派生为 false, overlay 自动消失.
 *  孩子还得等 server 发 wallet_update (家长批了 unlock 或日补) 或手动重启 App
 *  + 家长在后台明确动作才能恢复 Child. 跟"关机"的休息效果一致但不动设备电源. */
private fun doRest(ctx: Context) {
    AgentState.setMode(AgentState.Mode.Lock)
    // 退到桌面 — 不是强制 (Android 普通 App 没那种权限), 是温和地"我自己跳走"
    val home = Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_HOME)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK
    }
    runCatching { ctx.startActivity(home) }
}
