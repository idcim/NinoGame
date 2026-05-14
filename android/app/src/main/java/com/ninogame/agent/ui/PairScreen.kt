package com.ninogame.agent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.net.Api
import com.ninogame.agent.net.ApiException
import com.ninogame.agent.net.MagicLink
import com.ninogame.agent.ninoSettings
import kotlinx.coroutines.launch

/** 配对页 — 接受魔法链接 (含 URL + code) 或分两栏手填.
 *
 *  平板 / 大屏 (Expanded / Medium width class): 内容居中限宽 540dp, 不靠左挤;
 *  手机 (Compact): 撑满, 留 16dp 内边距.
 */
@Composable
fun PairScreen(
    windowSize: WindowSizeClass,
    onPaired: () -> Unit,
) {
    val settings = ninoSettings
    val scope = rememberCoroutineScope()
    val rememberedBackendUrl by settings.backendUrl.collectAsState(initial = null)

    var input by remember { mutableStateOf("") }
    var backendUrl by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var inputMode by remember { mutableStateOf(InputMode.MagicLink) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // 来过一次又重新配对的, 自动填回上次后端 URL
    LaunchedEffect(rememberedBackendUrl) {
        if (backendUrl.isBlank() && !rememberedBackendUrl.isNullOrBlank()) {
            backendUrl = rememberedBackendUrl!!
        }
    }

    fun trySubmit() {
        error = null
        val resolvedUrl: String
        val resolvedCode: String
        when (inputMode) {
            InputMode.MagicLink -> {
                val parsed = MagicLink.parse(input.trim())
                if (parsed == null) {
                    error = "看不出魔法链接 — 应该形如 https://host/#pair=XXXXXXXX"
                    return
                }
                resolvedUrl = parsed.backendUrl
                resolvedCode = parsed.code
            }
            InputMode.Manual -> {
                resolvedUrl = backendUrl.trim().trimEnd('/')
                resolvedCode = code.trim()
                if (!resolvedUrl.startsWith("http")) {
                    error = "后端地址要带 http:// 或 https://"
                    return
                }
                if (resolvedCode.length < 4) {
                    error = "配对码至少 4 位"
                    return
                }
            }
        }
        busy = true
        scope.launch {
            try {
                val r = Api.redeemPairingCode(resolvedUrl, resolvedCode)
                settings.savePairing(resolvedUrl, r.agent_token, r.device_id, r.child_id)
                onPaired()
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Throwable) {
                error = "网络错误: ${e.message ?: e::class.simpleName}"
            } finally {
                busy = false
            }
        }
    }

    val maxFormWidth = when (windowSize.widthSizeClass) {
        WindowWidthSizeClass.Compact -> Int.MAX_VALUE.dp
        else -> 540.dp
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .widthIn(max = maxFormWidth)
                .fillMaxWidth()
                .padding(PaddingValues(horizontal = 16.dp, vertical = 24.dp)),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.pair_title),
                style = MaterialTheme.typography.headlineMedium,
            )
            Text(
                text = stringResource(R.string.pair_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(8.dp))

            // 模式切 (魔法链接 / 手填) — segment 风格 row
            ModeSelector(inputMode) { inputMode = it }

            when (inputMode) {
                InputMode.MagicLink -> {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it; error = null },
                        label = { Text(stringResource(R.string.pair_code_label)) },
                        placeholder = { Text("https://ninogame.example.com/#pair=ABCDEFGH") },
                        leadingIcon = { Icon(Icons.Filled.Link, contentDescription = null) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        enabled = !busy,
                    )
                }
                InputMode.Manual -> {
                    OutlinedTextField(
                        value = backendUrl,
                        onValueChange = { backendUrl = it; error = null },
                        label = { Text(stringResource(R.string.pair_backend_url_label)) },
                        placeholder = { Text("https://ninogame.example.com") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        enabled = !busy,
                    )
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it.uppercase(); error = null },
                        label = { Text("8 位配对码") },
                        placeholder = { Text("ABCDEFGH") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        enabled = !busy,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters,
                        ),
                    )
                }
            }

            if (error != null) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        error!!,
                        modifier = Modifier.padding(12.dp),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            Button(
                onClick = { trySubmit() },
                enabled = !busy && (when (inputMode) {
                    InputMode.MagicLink -> input.isNotBlank()
                    InputMode.Manual -> backendUrl.isNotBlank() && code.isNotBlank()
                }),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.height(20.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.height(0.dp))
                    Text(text = "  " + stringResource(R.string.pair_pairing))
                } else {
                    Text(stringResource(R.string.pair_submit))
                }
            }
        }
    }
}

private enum class InputMode { MagicLink, Manual }

@Composable
private fun ModeSelector(current: InputMode, onChange: (InputMode) -> Unit) {
    // Material3 SegmentedButton 在 BOM 2024.06 可用, 但样式稍复杂;
    // 这里用更稳的两个 Filled/Outlined Button 切色, 视觉同效.
    androidx.compose.foundation.layout.Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        listOf(
            InputMode.MagicLink to "粘贴链接",
            InputMode.Manual    to "手填",
        ).forEach { (mode, label) ->
            if (mode == current) {
                Button(
                    onClick = { onChange(mode) },
                    modifier = Modifier.weight(1f),
                ) { Text(label) }
            } else {
                androidx.compose.material3.OutlinedButton(
                    onClick = { onChange(mode) },
                    modifier = Modifier.weight(1f),
                ) { Text(label) }
            }
        }
    }
}
