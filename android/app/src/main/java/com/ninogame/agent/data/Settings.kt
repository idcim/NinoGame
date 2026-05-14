package com.ninogame.agent.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** DataStore-backed 配置. SharedPreferences 的协程友好替代.
 *
 *  存:
 *    - backend_url      家长后台 URL (例 https://ninogame.example.com)
 *    - agent_token      配对成功后服务端发的长 token (WS Bearer 用)
 *    - device_id        服务端设备 UUID
 *    - child_id         绑定的孩子 UUID
 *
 *  Stage 2+ 加:
 *    - balance          本地 wallet cache
 *    - last_seen_rules  规则 JSON 缓存
 *    - mode             child / parent / lock
 */
private val Context.dataStore by preferencesDataStore(name = "ninogame_settings")

private val K_BACKEND_URL         = stringPreferencesKey("backend_url")
private val K_AGENT_TOKEN         = stringPreferencesKey("agent_token")
private val K_DEVICE_ID           = stringPreferencesKey("device_id")
private val K_CHILD_ID            = stringPreferencesKey("child_id")
private val K_CACHED_BALANCE      = intPreferencesKey("cached_balance")
private val K_APP_CATEGORIES_JSON = stringPreferencesKey("app_categories_json")

class Settings(private val ctx: Context) {

    val backendUrl: Flow<String?> = ctx.dataStore.data.map { it[K_BACKEND_URL] }
    val agentToken: Flow<String?> = ctx.dataStore.data.map { it[K_AGENT_TOKEN] }
    val deviceId:   Flow<String?> = ctx.dataStore.data.map { it[K_DEVICE_ID] }
    val childId:    Flow<String?> = ctx.dataStore.data.map { it[K_CHILD_ID] }
    /** v0.5.1+: 持久化 wallet 余额. Service 收到 wallet_update / hello_ack 时写;
     *  Service 进程被系统杀后, 重启时给 UI 一个不可信但有用的"上次余额"展示, 直到
     *  WS 重连成功收到新值. */
    val cachedBalance: Flow<Int?> = ctx.dataStore.data.map { it[K_CACHED_BALANCE] }

    /** v0.5.3+: 应用分类缓存 (CategoryCache 序列化的 JSON List<Entry>). 整张表
     *  一次写, 不分键 — 100-300 条 entry, 单 JSON ~50KB 完全 OK. */
    val appCategoriesJson: Flow<String?> = ctx.dataStore.data.map { it[K_APP_CATEGORIES_JSON] }

    /** 简洁的 "已配对没" 状态 — Dashboard / 起始路由用. */
    val isPaired: Flow<Boolean> = ctx.dataStore.data.map { p ->
        !p[K_AGENT_TOKEN].isNullOrBlank() && !p[K_BACKEND_URL].isNullOrBlank()
    }

    suspend fun savePairing(backendUrl: String, agentToken: String, deviceId: String, childId: String?) {
        ctx.dataStore.edit { p ->
            p[K_BACKEND_URL] = backendUrl
            p[K_AGENT_TOKEN] = agentToken
            p[K_DEVICE_ID]   = deviceId
            if (childId != null) p[K_CHILD_ID] = childId
        }
    }

    suspend fun clearPairing() {
        ctx.dataStore.edit { p: androidx.datastore.preferences.core.MutablePreferences ->
            p.remove(K_AGENT_TOKEN)
            p.remove(K_DEVICE_ID)
            p.remove(K_CHILD_ID)
            p.remove(K_CACHED_BALANCE)
            // backend_url 保留, 再配对时少打字
        }
    }

    suspend fun saveCachedBalance(balance: Int) {
        ctx.dataStore.edit { p -> p[K_CACHED_BALANCE] = balance }
    }

    suspend fun saveAppCategoriesJson(json: String) {
        ctx.dataStore.edit { p -> p[K_APP_CATEGORIES_JSON] = json }
    }

    /** 同步读 isPaired — BootReceiver 在 onReceive ~10s 预算内, runBlocking 读 OK. */
    suspend fun isPairedNow(): Boolean = isPaired.first()

    companion object {
        @Volatile
        private var INSTANCE: Settings? = null
        fun from(ctx: Context): Settings = INSTANCE ?: synchronized(this) {
            INSTANCE ?: Settings(ctx.applicationContext).also { INSTANCE = it }
        }
    }
}

// 让 import 更少: import data.* 之外, _ 用不到这俩
@Suppress("unused")
private val _typeMarker: Preferences.Key<String> = K_AGENT_TOKEN
