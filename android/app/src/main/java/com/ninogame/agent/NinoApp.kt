package com.ninogame.agent

import android.app.Application
import com.ninogame.agent.data.Settings
import com.ninogame.agent.service.WatchdogWorker

/** 应用单例.
 *
 *  Settings (DataStore) 在 Application 上挂一次, 后续从 [appContext] 拿.
 *  Stage 2+ AgentService 启动入口也在这里 (检测到已配对就拉 WS 长连接).
 */
class NinoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        // DataStore 头一次 read 才真正创建文件, 这里不预热, 留给首屏组件按需触发

        // v0.5.12+ 调度 Watchdog 周期 ping (15min). KEEP policy 重复调度也只一份;
        // 即使 AgentService 被孩子 / 国内 ROM 杀掉, Watchdog 也能拉回. 解配对时由
        // MainActivity 取消.
        WatchdogWorker.schedule(this)
    }

    companion object {
        @Volatile
        private var instance: NinoApp? = null

        val appContext: NinoApp
            get() = instance ?: error("NinoApp 没启动 — manifest android:name 写对没?")
    }
}

/** 在协程里方便拿 Settings, 一行: Settings.from(NinoApp.appContext) */
val ninoSettings: Settings
    get() = Settings.from(NinoApp.appContext)
