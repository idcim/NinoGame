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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.ninogame.agent.R
import com.ninogame.agent.ninoSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import com.ninogame.agent.net.Api
import kotlinx.serialization.json.Json
import kotlinx.serialization.Serializable

/** 更新日志页 — 拉 backend `/api/changelog` (公开端点) 渲染 markdown 子集.
 *
 *  v0.5.17+: 跟 admin Changelog 页 + Win agent About "查看更新日志" 同一份真相 —
 *  CHANGELOG.md 在 repo 根, backend docker-compose volume 挂进容器, 改 markdown
 *  立刻在三端可见 (60s 缓存).
 *
 *  渲染策略: 自实现 markdown 子集 (## 标题 / 列表 / **粗体** / `code` / blockquote),
 *  跟 admin/pages/Changelog.tsx 同口径. 不引第三方 markdown 库 — 节省 APK.
 */
@Composable
fun ChangelogScreen(
    windowSize: WindowSizeClass,
    onBack: () -> Unit,
) {
    val backendUrl by ninoSettings.backendUrl.collectAsState(initial = null)
    var content by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var reloadTick by remember { mutableStateOf(0) }

    LaunchedEffect(backendUrl, reloadTick) {
        loading = true
        err = null
        val base = backendUrl
        if (base.isNullOrBlank()) {
            err = "未配对, 拿不到 backend"
            loading = false
            return@LaunchedEffect
        }
        runCatching {
            withContext(Dispatchers.IO) {
                val url = base.trimEnd('/') + "/api/changelog"
                val req = Request.Builder().url(url).get().build()
                Api.client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}")
                    val body = resp.body?.string() ?: throw RuntimeException("空响应")
                    Json.decodeFromString<ChangelogResp>(body).content
                }
            }
        }.onSuccess {
            content = it
            loading = false
        }.onFailure {
            err = it.message ?: "加载失败"
            loading = false
        }
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
                .padding(PaddingValues(horizontal = 16.dp, vertical = 16.dp)),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // 头部: 返回 + 标题 + 刷新
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 4.dp).fillMaxWidth(),
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = null)
                }
                Text(
                    stringResource(R.string.changelog_title),
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { reloadTick++ }) {
                    Icon(Icons.Filled.Refresh, contentDescription = null)
                }
            }

            Text(
                stringResource(R.string.changelog_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (loading) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }
            }

            if (err != null && !loading) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            stringResource(R.string.changelog_error, err!!),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                        OutlinedButton(onClick = { reloadTick++ }, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Filled.Refresh, contentDescription = null)
                            Text("  " + stringResource(R.string.changelog_retry))
                        }
                    }
                }
            }

            content?.let {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        MarkdownBlocks(md = it)
                    }
                }
            }
        }
    }
}

@Serializable
private data class ChangelogResp(val content: String, val format: String = "markdown")

/** Markdown 子集渲染 — 跟 admin Changelog.tsx renderMarkdown 同口径.
 *  支持: # / ## 标题 + - / * 列表 + > blockquote + 段落 + inline `code` / **bold**.
 *
 *  实现: 两阶段
 *    1. parseBlocks(md): pure 函数, 把 markdown 拆成 sealed class Block 列表
 *    2. Composable Column { for (b in blocks) RenderBlock(b) } — 单层 Composable 循环
 *  这样可以避免 "nested non-Composable fun 调 Composable" 的编译错. */
private sealed class Block {
    data class H1(val text: String) : Block()
    data class H2(val text: String) : Block()
    data class Para(val text: String) : Block()
    data class Bq(val text: String) : Block()
    data class Bullets(val items: List<String>) : Block()
}

private fun parseBlocks(md: String): List<Block> {
    val out = mutableListOf<Block>()
    val lines = md.split("\r\n", "\n")
    val listBuf = mutableListOf<String>()
    val paraBuf = mutableListOf<String>()

    fun flushList() {
        if (listBuf.isNotEmpty()) {
            out.add(Block.Bullets(listBuf.toList()))
            listBuf.clear()
        }
    }
    fun flushPara() {
        if (paraBuf.isNotEmpty()) {
            val text = paraBuf.joinToString(" ").trim()
            paraBuf.clear()
            if (text.isNotEmpty()) out.add(Block.Para(text))
        }
    }

    for (raw in lines) {
        val line = raw.trimEnd()
        if (line.isBlank()) {
            flushList(); flushPara(); continue
        }
        val h1 = Regex("^# (.+)$").matchEntire(line)
        if (h1 != null) { flushList(); flushPara(); out.add(Block.H1(h1.groupValues[1])); continue }
        val h2 = Regex("^## (.+)$").matchEntire(line)
        if (h2 != null) { flushList(); flushPara(); out.add(Block.H2(h2.groupValues[1])); continue }
        val li = Regex("^[-*] (.+)$").matchEntire(line)
        if (li != null) { flushPara(); listBuf.add(li.groupValues[1]); continue }
        val bq = Regex("^> (.+)$").matchEntire(line)
        if (bq != null) { flushList(); flushPara(); out.add(Block.Bq(bq.groupValues[1])); continue }
        paraBuf.add(line)
    }
    flushList(); flushPara()
    return out
}

@Composable
private fun MarkdownBlocks(md: String) {
    val blocks = remember(md) { parseBlocks(md) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (b in blocks) {
            when (b) {
                is Block.H1 -> {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        b.text,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
                is Block.H2 -> {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        b.text,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                is Block.Para -> {
                    Text(
                        inlineRender(b.text),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                is Block.Bq -> {
                    Text(
                        inlineRender(b.text),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
                is Block.Bullets -> {
                    for (item in b.items) {
                        Row(verticalAlignment = Alignment.Top) {
                            Text(
                                "•  ",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Text(
                                inlineRender(item),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                }
            }
        }
    }
}

/** Inline `code` / **bold** 渲染. Compose 端简化为去掉标记后纯文本 + 在 code 用 monospace
 *  (不上 AnnotatedString 多 style 拼接 — 那要写一堆 SpanStyle, 阅读体验不如纯文字).
 *  实质效果: 标记符脱掉, 内容直接展示, 易读为先. */
private fun inlineRender(s: String): String {
    var out = s
    // **bold** → bold (保留, 不加 emphasis — Compose Text 一律单 style)
    out = out.replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
    // `code` → code (脱掉 backtick)
    out = out.replace(Regex("`([^`]+)`"), "$1")
    return out
}

// 抑制 unused warning (TextDecoration 仅未来扩展用)
@Suppress("unused")
private val _td = TextDecoration.None
