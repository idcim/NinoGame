# NinoGame Android Agent (v0.5.0+ / Stage 1)

跨端 (Windows + Android) 家长控制 Agent 的 **Android 端骨架**。当前进度: **Stage 1 — 仅配对联机**。

> **当前状态**: 项目骨架 + Compose 配对 UI + HTTP `/pair/redeem` + DataStore 持久化. WebSocket / Foreground Service / AccessibilityService / 拦截 / token 经济都在 **Stage 2+** 实施.

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

## 当前能做什么 (Stage 1)

启动 App → 配对页:

1. **粘贴魔法链接** (推荐): 家长后台 `/pair-codes` 生成的码会带形如 `https://ninogame.example.com/#pair=ABCDEFGH`, 粘贴整段
2. **手填**: 后端 URL + 8 位码分开填

点"配对" → 成功后 DataStore 存 `agent_token / device_id / child_id / backend_url`, 跳到主面板. 主面板目前仅显示已配对状态 + ID 摘要.

**重新配对** 按钮清掉 token, 回配对页.

## 还没做 (Stage 2+ 路线图)

| Stage | 内容 | 大致工作量 |
|---|---|---|
| 2 | Foreground Service + WebSocket 长连接 (hello / heartbeat / event / wallet_update) | 中 |
| 2 | AccessibilityService 监前台 app (替代 Windows 端 EnumWindows) | 中 |
| 3 | 规则匹配 + 拦截 (PvZ 等 → 弹对话框 + 回到 launcher) | 中 |
| 3 | Token 经济本地版 (server 权威, 本地缓存 + wallet_update 推送对齐) | 小 |
| 3 | 申请游戏时间 UI (跟 Windows 端 RequestDialog 同协议) | 小 |
| 3 | 责任清单 / 任务申报 UI | 小 |
| 4 | 国内 ROM 适配 (MIUI/华为/OPPO/vivo 自启动 + 后台权限白名单引导页) | 中 |
| 4 | 开机自启 (BootReceiver) | 小 |
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
│           ├── MainActivity.kt            # Compose host + Navigation
│           ├── data/Settings.kt           # DataStore (backend_url / agent_token / device_id / child_id)
│           ├── net/
│           │   ├── Api.kt                 # HTTP + 配对兑换 (OkHttp + kotlinx.serialization)
│           │   ├── WsClient.kt            # Stage 2+ WebSocket 长连接
│           │   └── Messages.kt            # hello / hello_ack / 协议 dataclass
│           └── ui/
│               ├── Theme.kt               # NinoGame 配色 (Material 3 + Material You 动态色)
│               ├── PairScreen.kt          # 配对 (魔法链接 / 手填 两 mode)
│               └── DashboardScreen.kt     # 已配对状态 + 重新配对
```

## 跟主仓库的协议关系

Android Agent 跟 Windows Agent **共用同一个后端 + 同一套协议** (CLAUDE.md §19). 配对码 / agent_token 走的是 `/api/devices/pair/redeem` 共享端点, server 端区分平台靠 `platform: "android"` 字段; Agent 升级、规则同步、钱包同步将来都跟 Windows 端走同一条 WS 链路.

> **设计哲学**: CLAUDE.md §1.2 — 让系统逐步退场. Android 端不是另起炉灶, 是孩子主用平板时一份等价能力, 跟 Windows 端无缝同步 token / 规则 / 模式.
