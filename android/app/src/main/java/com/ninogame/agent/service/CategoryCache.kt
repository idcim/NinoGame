package com.ninogame.agent.service

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import com.ninogame.agent.data.Settings
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** 应用分类缓存 — Android 端跟 Windows agent classifier.py 同语义.
 *
 *  数据流:
 *    1. ForegroundAppMonitor.setForeground(pkg) → 见到未在缓存的 pkg → noteUnknown(pkg)
 *    2. UnknownAppsReporter 60s 一次 drainPending() → 发 unknown_apps WS 消息
 *    3. server LLM 分类 → 推 app_categories_update → AgentService.onAppCategoriesUpdate
 *       → upsert() 写本地缓存 + 持久化 DataStore
 *    4. UsageReporter.reportOnce() 调 getCategory(pkg) 拿到真实 category, 不再硬编码 neutral
 *
 *  线程安全: 全部 @Synchronized. Map 读取走 synchronized 但 hot path (UsageReporter
 *  内调 getCategory) 频率很低 (5min/次), 锁开销可忽略.
 *
 *  持久化: DataStore stringPreferencesKey("app_categories_json"). 整张表序列化
 *  一个 JSON. 大小估算: 一台平板生命周期 100-300 个 app, 每条 ~150 字节, 总 ~50KB,
 *  写 DataStore 完全 OK.
 */
object CategoryCache {

    @Serializable
    data class Entry(
        val app_identifier: String,
        val category: String,           // "consumption" / "productive" / "neutral"
        val sub_type: String = "",
        val display_name: String? = null,
        val cached_at_ms: Long,
    )

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val entries = mutableMapOf<String, Entry>()
    private val pending = mutableSetOf<String>()

    @Synchronized
    fun getCategory(pkg: String): String? = entries[pkg]?.category

    @Synchronized
    fun getDisplayName(pkg: String): String? = entries[pkg]?.display_name

    /** ForegroundAppMonitor 见到未知 pkg 时调. 已经在 entries 里就跳过. */
    @Synchronized
    fun noteUnknown(pkg: String) {
        if (entries.containsKey(pkg)) return
        pending.add(pkg)
    }

    @Synchronized
    fun drainPending(): Set<String> {
        if (pending.isEmpty()) return emptySet()
        val out = HashSet(pending)
        pending.clear()
        return out
    }

    /** server 推 app_categories_update 后调. 同步写内存 + 异步持久化. */
    fun upsert(newEntries: List<Entry>, ctx: Context) {
        synchronized(this) {
            for (e in newEntries) {
                entries[e.app_identifier] = e
                pending.remove(e.app_identifier)
            }
        }
        // 不阻塞调用方; persist 失败认了 — 下次 server 推还能补
        runCatching { persistSync(ctx) }
            .onFailure { Log.w(TAG, "category cache persist failed", it) }
    }

    /** AgentService onCreate 启动时调一次 — 把上次进程存盘的恢复回内存. */
    suspend fun load(ctx: Context) {
        val raw = Settings.from(ctx).appCategoriesJson.first()
        if (raw.isNullOrBlank()) return
        runCatching {
            val list = json.decodeFromString<List<Entry>>(raw)
            synchronized(this) {
                entries.clear()
                for (e in list) entries[e.app_identifier] = e
            }
            Log.i(TAG, "category cache loaded: ${list.size} entries")
        }.onFailure { Log.w(TAG, "category cache load failed (corrupt JSON?), 忽略", it) }
    }

    /** sync 写 DataStore — 调用方应在 IO 协程里调. 这里用 GlobalScope 反而坑,
     *  改为暴露 suspend persist + 调用方在 scope 里 launch. */
    private fun persistSync(ctx: Context) {
        val snapshot = synchronized(this) { entries.values.toList() }
        val serialized = json.encodeToString(snapshot)
        // 用 ctx.applicationContext 防 Activity 引用泄漏
        kotlinx.coroutines.runBlocking {
            Settings.from(ctx.applicationContext).saveAppCategoriesJson(serialized)
        }
    }

    /** PackageManager 解析 pkg → 应用标签 (中文名 / 英文名), 给 LLM 做分类提示.
     *  失败返回 null (装了 pkg 又卸载等边界). */
    fun resolveAppLabel(ctx: Context, pkg: String): String? {
        return runCatching {
            val pm = ctx.packageManager
            val info = pm.getApplicationInfo(pkg, 0)
            pm.getApplicationLabel(info).toString()
        }.getOrNull()
    }

    @Synchronized
    fun reset() {
        entries.clear()
        pending.clear()
    }

    private const val TAG = "CategoryCache"
}
