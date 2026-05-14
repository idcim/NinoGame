# NinoGame Android Agent (v0.5.0+ / Stage 1)

跨端 (Windows + Android) 家长控制 Agent 的 **Android 端骨架**。当前进度: **Stage 1 — 仅配对联机**。

> **当前状态 (v0.5.7)**: 全闭环 — 配对 + WS + 监前台 + usage_report + LLM 分类 + 开机自启 + 拦截 + block 事件 + command + mode + token_tick ✅ + **申请游戏时间 UI + screen-off 5min 自动 Lock** ✅. 任务 UI 在 **Stage 3b4** 实施.

## 兼容范围

| 项 | 值 |
|---|---|
| minSdk | 24 (Android 7.0 / Nougat, 2016) — 老平板也能装 |
| targetSdk / compileSdk | 34 (Android 14) |
| Kotlin | 2.0.0 |
| Gradle | 8.7 |
| AGP | 8.5.2 |
| UI | Jetpack Compose + Material 3 + WindowSizeClass (**手机 / 平板 / 折叠屏自适应**) |

平板兼容已经设计在内:
- `minSdk 24` 覆盖 2017 年后的所有平板
- Compose `WindowSizeClass` 区分 Compact / Medium / Expanded, 平板大屏 (Medium/Expanded) 内容居中限宽 540dp (配对) / 720dp (主面板), 不会把表单拉成屏幕一整行
- AndroidManifest 无 `<supports-screens>` 限制, Android 8+ 默认全屏寸适配
- 横竖屏切换 `configChanges` 全声明, 不会重启 Activity

## 环境准备 (Windows / macOS / Linux 任一)

### 1. JDK 17

```powershell
winget install Microsoft.OpenJDK.17   # Windows
# 或 https://adoptium.net/ 下 Temurin 17 LTS
```

验证: `java -version` 输出 `openjdk version "17.x.x"`.

### 2. Android Studio (最新稳定版 + Android SDK)

下载 https://developer.android.com/studio (Hedgehog 2023.1.1+ 或更新).

首次打开会自动装 SDK 34 platform + build-tools, 也可手动:

```
Settings → Languages & Frameworks → Android SDK
  ☑ Android 14 (API 34) — SDK Platform + Sources
  ☑ Android SDK Build-Tools 34.0.0
  ☑ Android SDK Command-line Tools (最新)
  ☑ Android Emulator (可选, 真机就不要)
```

设环境变量 `ANDROID_HOME` 指向 `%LOCALAPPDATA%\Android\Sdk` (Windows) 或 `~/Library/Android/sdk` (mac).

### 3. 打开项目

```
Android Studio → File → Open → 选 G:\DEL_GAME\android\
```

第一次会自动 sync, 拉所有依赖 (Compose BOM / OkHttp / DataStore / kotlinx.serialization). 国内速度可能慢, 必要时配 Gradle 镜像:

`%USERPROFILE%\.gradle\init.gradle` 加:

```groovy
allprojects {
    repositories {
        maven { url 'https://maven.aliyun.com/repository/google' }
        maven { url 'https://maven.aliyun.com/repository/central' }
    }
}
```

### 4. 生成 Gradle wrapper jar (第一次)

仓库**没**提交 `gradle/wrapper/gradle-wrapper.jar` (二进制), 需要本机生成一次:

```powershell
cd android
gradle wrapper --gradle-version 8.7
```

需要先 `winget install Gradle.Gradle` 或者用 Android Studio 内置的 wrapper init (大多数 IDE 会自动恢复 wrapper jar). 完成后下次 build 走 `gradlew.bat` 不依赖全局 gradle.

## 构建 + 安装

### 命令行 (推荐 CI 用)

```powershell
cd android
gradlew.bat assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Android Studio

`Run → Run 'app'` 选连接的设备或模拟器即可.

### 平板真机调试

1. 平板 → 设置 → 关于平板 → 连点版本号 7 次开启"开发者选项"
2. 设置 → 开发者选项 → ☑ USB 调试
3. USB 连电脑, 第一次会弹"授权该计算机"
4. `adb devices` 看到设备就能 `Run`

## 当前能做什么 (Stage 1 + Stage 2a)

启动 App → 配对页:

1. **粘贴魔法链接** (推荐): 家长后台生成的码会带形如 `https://ninogame.example.com/#pair=ABCDEFGH`, 粘贴整段
2. **手填**: 后端 URL + 8 位码分开填

点"配对" → 成功后 DataStore 存 `agent_token / device_id / child_id / backend_url`, 跳到主面板.

**主面板** (Stage 2a 已落):
- **顶部连接徽章**: 实时显示 WS 连接状态 (🟢 已联机 / 🟡 连接中 / ⚪ 离线 / 🔴 失败)
- **Token 余额**: 实时来自 server `wallet_update` 推送 + 离线时显示 DataStore 缓存的"上次同步"值
- **规则数**: `hello_ack` / `rules_update` 收到后实时刷新 (Stage 2b 解析规则做拦截)
- **重新配对**: 清 token + 停 Service, 回配对页

**后台 Foreground Service** (`AgentService`):
- 配对后自动启动, 解配对自动停
- 通知栏常驻"NinoGame 在运行" (IMPORTANCE_LOW, 不打扰)
- WebSocket 长连接 + 心跳 30s/次 + 断线指数退避重连 (1s→2s→4s→...→60s 封顶)
- 服务端推送 `wallet_update` / `rules_update` 等消息即时分发到 `AgentState` 单例, UI 自动刷新

**前台 app 监控** (Stage 2b, v0.5.2+):
- 首次需要去系统设置 → 无障碍 → 已安装的服务 → **NinoGame Agent → 开启**. Dashboard 检测到未启用时顶部黄色横幅 + "去启用"按钮一键跳转
- 启用后 `NinoAccessibilityService` 监听 `TYPE_WINDOW_STATE_CHANGED`, 抓 `event.packageName` 喂 `ForegroundAppMonitor` singleton
- 同一 app 持续前台 ≥ 2 秒才记入 segment; 自家 app + 系统 launcher (`com.miui.home` / `com.android.launcher3` 等) 自动跳过, 不污染数据
- `UsageReporter` 每 5 分钟把已 close 的 segments + 当前 open 切一片 一起打包成 `usage_report` 发 server (协议跟 Windows agent 同源, CLAUDE.md §10.4)
- Server `onUsageReport` 写 `app_sessions` 表; /reports 页 Top 应用 / 每日时长会立刻看到 Android 端使用记录
- **不读屏 / 不取内容 / 不录密码** — 只取 packageName. AccessibilityServiceInfo 配置 `canRetrieveWindowContent="false"`, 系统不会给 view 树访问权.

## 还没做 (Stage 2+ 路线图)

| Stage | 内容 | 状态 |
|---|---|---|
| 2a | Foreground Service + WebSocket 长连接 (hello / heartbeat / wallet_update / rules_update) | ✅ v0.5.1 |
| 2b | AccessibilityService 监前台 app (替代 Windows 端 EnumWindows) | ✅ v0.5.2 |
| 2b | UsageReporter 上报 app_session (5min 间隔, 用法同 Windows agent) | ✅ v0.5.2 |
| 2c | unknown_apps 上报让 server LLM 分类 → 本地 category cache (告别全 neutral) | ✅ v0.5.3 |
| 2c | BootReceiver 开机自启 | ✅ v0.5.3 |
| 3a | 规则匹配 + 拦截 (PvZ 等 → 弹通知 + 回桌面) + block 事件上报 | ✅ v0.5.4 |
| 3b1 | Command 接收 (temporary_unlock / lock_device / start_free_pass) + mode 状态 | ✅ v0.5.5 |
| 3b2 | TokenTicker 每分钟 token_tick 上报 (server 单一权威扣分) | ✅ v0.5.6 |
| 3b3 | 申请游戏时间 UI (unlock_request) + screen-off 5min 自动 Lock | ✅ v0.5.7 |
| 3b4 | 任务申报 UI / 责任清单 UI / 余额详情页 | 待 |
| 3 | Token 经济本地版 (server 权威, 本地缓存 + wallet_update 推送对齐) | 待 |
| 3 | 申请游戏时间 UI (跟 Windows 端 RequestDialog 同协议) | 待 |
| 3 | 责任清单 / 任务申报 UI | 待 |
| 4 | 国内 ROM 适配 (MIUI/华为/OPPO/vivo 自启动 + 后台权限白名单引导页) | 待 |
| 4 | 开机自启 (BootReceiver) | 待 |
| 4 | 跨端钱包聚合 (Path 1 阅读类等), 但 Path 1 在决策 #33 已下线, 暂搁置 | — |

## 已知约束 / 设计取舍

- **AccessibilityService 是必须的**: 监测前台 app 在 Android 6.0+ 已经强制走这条路, 没有"无障碍能力"的 Agent 装了也白装. 家长需要手动引导孩子在系统设置里启用一次.
- **国内 ROM 的"杀后台"**: MIUI / 华为 / vivo 默认会把不在白名单的 App 后台杀掉. Stage 4 会加引导页教家长把 NinoGame 加白名单 + 关电池优化. 这一步 **没办法纯代码搞定**, 必须用户主动操作.
- **Play Store 政策**: 拦截类 App 不让上 Play Store 是常事. 走 sideload (家长后台下 APK 直接装) 或自家分发渠道. v0.5.0+ Agent 升级走的 server `/artifacts/` 机制可以直接复用, 给 Android 也搭一份就行.

## 仓库结构

```
android/
├── README.md                              # 本文件
├── settings.gradle.kts                    # 子模块声明 + 仓库
├── build.gradle.kts                       # 根构建脚本 (插件版本)
├── gradle.properties                      # JVM / parallel / cache
├── gradle/wrapper/gradle-wrapper.properties
├── app/
│   ├── build.gradle.kts                   # app 模块构建 + 依赖
│   ├── proguard-rules.pro                 # release 混淆豁免
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── res/
│       │   ├── values/strings.xml         # 中文 (默认)
│       │   ├── values/colors.xml
│       │   ├── values/themes.xml          # Material 3 base
│       │   └── xml/                       # backup_rules + data_extraction_rules
│       └── java/com/ninogame/agent/
│           ├── NinoApp.kt                 # Application 入口 + appContext
│           ├── MainActivity.kt            # Compose host + Navigation + Service 启停联动
│           ├── data/Settings.kt           # DataStore (backend_url / agent_token / device_id / child_id / cached_balance)
│           ├── net/
│           │   ├── Api.kt                 # HTTP + 配对兑换 (OkHttp + kotlinx.serialization)
│           │   ├── WsClient.kt            # WebSocket 长连接 (OkHttp WS, ?token= query auth)
│           │   └── Messages.kt            # hello / hello_ack / 协议 dataclass
│           ├── service/
│           │   ├── AgentService.kt        # ✨ Foreground Service: 持 WS + 心跳 30s + 退避重连 1s→60s
│           │   └── AgentState.kt          # ✨ 进程内 singleton StateFlow (connection/balance/rulesCount)
│           └── ui/
│               ├── Theme.kt               # NinoGame 配色 (Material 3 + Material You 动态色)
│               ├── PairScreen.kt          # 配对 (魔法链接 / 手填 两 mode)
│               └── DashboardScreen.kt     # 实时连接 + 余额 + 规则数 + 重新配对
```

## 跟主仓库的协议关系

Android Agent 跟 Windows Agent **共用同一个后端 + 同一套协议** (CLAUDE.md §19). 配对码 / agent_token 走的是 `/api/devices/pair/redeem` 共享端点, server 端区分平台靠 `platform: "android"` 字段; Agent 升级、规则同步、钱包同步将来都跟 Windows 端走同一条 WS 链路.

> **设计哲学**: CLAUDE.md §1.2 — 让系统逐步退场. Android 端不是另起炉灶, 是孩子主用平板时一份等价能力, 跟 Windows 端无缝同步 token / 规则 / 模式.
