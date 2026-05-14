package com.ninogame.agent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.service.PinManager
import kotlinx.coroutines.launch

/** PIN 验证对话框 — 跟 Windows agent PinDialog (qt_dialogs.PinDialog) 等价.
 *
 *  - 4-6 位数字输入, PasswordVisualTransformation 隐藏字符
 *  - 错 1-2 次显示"还剩 N 次"
 *  - 错 3 次锁定 30 分钟显示倒计时, 锁定期间按钮 disable
 *  - 验证成功 onSuccess() 关 dialog
 *
 *  调用方: DashboardScreen "重新配对" 按钮 → if PIN set 弹这个 → 通过才 clearPairing.
 */
@Composable
fun PinDialog(
    onDismiss: () -> Unit,
    onSuccess: () -> Unit,
) {
    var pin by remember { mutableStateOf("") }
    var hint by remember { mutableStateOf<String?>(null) }
    var locked by remember { mutableStateOf(false) }
    var verifying by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    fun submit() {
        if (pin.isBlank() || verifying || locked) return
        verifying = true
        scope.launch {
            val result = PinManager.verify(ctx, pin)
            verifying = false
            when (result) {
                is PinManager.VerifyResult.Ok -> {
                    onSuccess()
                }
                is PinManager.VerifyResult.NotSet -> {
                    // 不该走到这条 — 调用方应该先检查 pinIsSet. 兜底直接通过.
                    onSuccess()
                }
                is PinManager.VerifyResult.Fail -> {
                    hint = ctx.getString(R.string.pin_fail_remaining, result.remainingAttempts)
                    pin = ""
                }
                is PinManager.VerifyResult.Locked -> {
                    hint = ctx.getString(R.string.pin_locked, result.remainingMinutes)
                    locked = true
                    pin = ""
                }
            }
        }
    }

    // 进入对话框时已经锁定, 先查一次
    LaunchedEffect(Unit) {
        when (val r = PinManager.verify(ctx, "")) {
            is PinManager.VerifyResult.Locked -> {
                hint = ctx.getString(R.string.pin_locked, r.remainingMinutes)
                locked = true
            }
            else -> Unit
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.pin_dialog_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.pin_dialog_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = pin,
                    onValueChange = { new ->
                        // 仅数字 + 上限 6 位
                        if (new.all { it.isDigit() } && new.length <= 6) pin = new
                    },
                    label = { Text(stringResource(R.string.pin_dialog_label)) },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    singleLine = true,
                    enabled = !verifying && !locked,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (hint != null) {
                    Text(
                        hint!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { submit() },
                enabled = !verifying && !locked && pin.length >= 4,
            ) {
                Text(stringResource(R.string.pin_dialog_verify))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.dialog_cancel))
            }
        },
    )
}
