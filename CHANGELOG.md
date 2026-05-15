# NinoGame 更新日志

> 跨端 (Backend / Admin / Parent Frontend / Windows Agent / Android Agent) 的版本历史。
> Backend 主版本号当前在 v0.4.x; Android Agent 在 v0.5.x; Windows Agent 在 v0.4.x. 各端独立演进, 但通过 hello_ack / WS 协议保持兼容。
> 详细 commit 在 git log 里, 这里只保留"对用户有意义的变化"。

## Android v0.5.21 · 2026-05-15

- **Parent → Child 切换 UI** — 家长用 PIN 解 OOT 进 Parent 模式帮孩子查东西后, Dashboard ModeAndFreePassCard 现在显示"交回给孩子"按钮直接切回 Child, 不再卡死. Lock 模式同款按钮但需 PIN (防孩子绕开).
- **真锁屏 (OS 级)** — "锁屏休息"按钮原来只 setMode(Lock)+退桌面, 孩子在桌面还能切 app. 现在调 NinoAccessibilityService.lockScreenNow() → `GLOBAL_ACTION_LOCK_SCREEN` (API 28+) 触发系统锁屏, 解锁要手机 PIN/指纹. API 28 以下 fallback 回 Home.
- **Lock 模式跨 app 强拉** — AccessibilityService 把 isLocked 判定改为 `outOfToken || mode==Lock`. 之前 Lock 模式没强拉, 孩子能跑掉; 现在跟 OOT 同款拦截, 切到任何非系统-passthrough 的 app 立刻被拉回 NinoGame Lock 屏.
- **OOT 锁屏页加应急按钮** — "打电话" / "发短信" 两个 OutlinedButton, 点开走 Intent.ACTION_DIAL / smsto:, AccessibilityService passthrough 已允许 dialer/sms 包不被强拉回. 跟 OS 紧急 SOS 同思路, 给孩子留紧急通讯出路.
- **转 token 后 Lock 自动解** — wallet_update 处理时 `balance 从 ≤0 跌到 >0` + 当前 Lock 模式 → 自动 setMode(Child). 修家长反馈 "我转了 token 但手机 App 还是锁着的". 0→正这条边触发, 避免本来余额就 >0 时孩子主动锁屏被立刻解.

## infra: dev-adb-reverse.ps1 · 2026-05-15

- 新增 `infra/dev-adb-reverse.ps1` — Windows PC 真机 / 模拟器 dev 反向端口转发脚本. 自动找 adb (PATH / 常见 Android SDK 路径), 对每个已连接设备 reverse 8088/8080/8081 → 127.0.0.1.
- 为什么需要: Docker Desktop on Windows 11 (尤其 Insider 26200) WSL2 backend 的端口 bind 实际只在 127.0.0.1, LAN IP + netsh portproxy + 防火墙开放后 PC 自己用 LAN IP 都 timeout. adb reverse 走 USB 通道完全绕过. 之后 Android App Pair 页 Backend URL 填 `http://127.0.0.1:8088` 即可.

## Android v0.5.20 · 2026-05-15

- **OOT 锁屏主动触发 — 不打开 App 也能锁** — 用户反馈"0 token 时也可以在外面乱玩, 不打开本 APP 就没事". v0.5.19 OOT 强拉只在 AccessibilityService.onAccessibilityEvent (窗口切换) 时检查, 用户已经在 Chrome 玩 + balance 刚跌到 0 时窗口没切 → 锁屏不触发, 孩子能继续玩到自己主动换 app.
- AgentService onCreate 加协程 `AgentState.outOfToken.collectLatest { ... }`: 派生从 false→true 的瞬间 (balance 跌到 0 / free_pass 到期 / mode 切回 Child 等场景) 主动 `launchMainActivity()` 强拉自家到前台. AccessibilityService 接力执行后续反弹.
- launchMainActivity: Intent(MainActivity) FLAG_ACTIVITY_NEW_TASK | REORDER_TO_FRONT | SINGLE_TOP. Foreground Service 是 Android 10+ 后台启 Activity 的合法路径之一.
- 现在三个触发点全覆盖: a) AgentState 派生 OOT 变 true (主动); b) AccessibilityService onAccessibilityEvent OOT (用户切窗口被动); c) OutOfTokenScreen 内 Compose overlay 渲染.

## Android v0.5.19 · 2026-05-15

- **OOT 全屏锁强化 — 不可跳过** — 用户反馈"安卓 token 用完显示不完美, 应该是全屏锁无法跳过". v0.5.16 NinoAccessibilityService 只在前台是 consumption 类时 GLOBAL_ACTION_HOME, 桌面/浏览器/学习类全能跳过. 改成: outOfToken=true + 前台非自家 + 非系统 passthrough → 用 `Intent(MainActivity, FLAG_ACTIVITY_NEW_TASK | REORDER_TO_FRONT | SINGLE_TOP)` 强拉 NinoGame 回前台.
- 桌面 launcher 也拦 (跟"全屏锁"语义一致). 孩子只能走三按钮: 申请游戏时间 / 家长 PIN 解锁 / 锁屏休息 — 没有"等一等就过"的逃逸.
- 系统级 passthrough 保留: `android` / `com.android.systemui` (通知栏可用) / IME (PIN 输入要键盘) / 拨号 + 通讯录 (紧急通话不被锁拦; 家长真想拦可远程加规则).
- BlockNotifier.notifyOutOfToken 自带 5s dedupe 防通知爆.

## Android v0.5.18 · 2026-05-15

- **修 Android 完全不扣 token 的 bug (主因)** — Api.kt OkHttp 没设 `pingInterval`. Server `onHeartbeat` 只更新 `last_seen_at` 不回消息. 30s readTimeout 触发后 WS 频繁断 (docker logs 显示每 19-20s 一次 `/ws/agent disconnected`), connectLoop 重连后 TokenTicker 60s 间隔的 delay 永远跑不满, 实际从来不发 `token_tick`. 加 `pingInterval(20s)` 走 WS 协议级 PING/PONG 保活, server 自动响应不用改代码.
- **修桌面 launcher 仍扣 token (附带 bug)** — ForegroundAppMonitor.IGNORED_PACKAGES 硬编码列表缺 Pixel `com.google.android.apps.nexuslauncher` / 三星 / 一加 / Nova 等. 改成运行时 `discoverIgnoredPackages(context)` 查 PackageManager 的 CATEGORY_HOME + ACTION_INPUT_METHOD, 一次拉所有 launcher + IME 包名进 ignoredPackages. STATIC_IGNORED 保留作 fallback. AgentService.onCreate 调用一次.
- versionCode 1 → 18, versionName 0.5.0 → 0.5.18 (跟齐 CHANGELOG, 之前 build.gradle 一直没跟上).

## Backend v0.4.10 · 2026-05-15

- **规则 UI + LLM 兼容 Android 端** — 规则页文案 / 提示 / 占位符全改成"跨端通用"语言, LLM 一句话生成规则时 keywords 同时给中文名 + 英文别名 + Windows 进程名 + Android 包名. 数据模型不动 (matchers 仍是 process_name/window_title 字段), Agent 端早已兼容: Android RuleEngine v0.5.4 把所有 matcher 对 packageName 匹配, v0.5.13 又加了 CategoryCache.display_name 匹配, PC 关键词在 Android 端早就能命中, 只是 UI 没引导.
- 例: 输入"禁止玩原神" → LLM 现在生成 `["原神","genshin","yuanshen","com.mihoyo.genshinimpact"]` 包含手机包名, 让 Android 端识别更稳.
- 家长前端规则页 (/rules) 副标题改"PC + Android Agent 同时同步"; 关键词 hint 写清"中文名/英文名/进程名/Android 包名都接受"; 关键词 placeholder 换成 `微信, wechat, com.tencent.mm`.

## Windows Agent v0.4.1 · 2026-05-15

- **About 对话框接入更新日志** — 「关于 NinoGame」加 "查看更新日志" 按钮 → 新 `ChangelogDialog` 拉 backend `/api/changelog` 用 QTextBrowser.setMarkdown() 原生渲染. 三端 (admin / Android / Win agent) 共享同一份变更记录, 跟 v0.4.9 backend / v0.5.17 Android 同源.
- 后台线程 fetch (urllib + Qt 信号回主线程), 不阻塞 UI; 失败时显示"加载失败 + 刷新"按钮可重试.
- 未配对时提示"请先完成设备配对", 不崩.

## Android v0.5.16 · 2026-05-15

- **0-token 锁屏 + 三按钮 (申请 / 家长 PIN / 锁屏休息)** — 余额耗尽时弹全屏覆盖, 跟 Windows agent `out_of_token_dialog.py` 同语义. AccessibilityService 把消费类前台赶回桌面.
- `AgentState.outOfToken` 派生 StateFlow (balance≤0 + Child + 非限免), 任一相关状态变化自动 recompute.
- Balance 回正自动消失 overlay, mode → Parent / Lock 也消失。

## Android v0.5.15 · 2026-05-15

- **配色对齐 Windows agent + parent frontend** — Theme.kt 改用 `#1ea7c4` 品牌青蓝 (跟 `agent/ui/panel.py` 同源). 取消 Material You dynamic color 防 OEM 主题盖品牌.
- **App 名称统一 "NinoGame"** — 之前是 "NinoGame Agent", 改齐 Win / Parent.
- **Dashboard 拆分 + Settings 抽离** — "已联机"卡 / Backend URL / Device IDs / 重新配对 全搬到新 SettingsScreen, 孩子日常 Dashboard 只剩余额/任务/申请. 右上 ⚙ 按钮跳设置.
- **关于我们 (AboutDialog)** — logo + tagline + blurb + GitHub 链接, 跟 `agent/ui/about_dialog.py` 同口径。

## Admin v0.4.8 · 2026-05-15

- **每日总结推送 admin UI** — backend v0.4.7 的 daily_summary_scheduler 现在可在 admin /push 页配置 (启用 checkbox + HH:MM + "立即触发一次" 测试按钮).
- 推送 admin 路由 `/api/admin/daily-summary` + `/trigger` 端点.

## Android v0.5.14 · 2026-05-14

- **PIN 验证 PBKDF2 对齐 Windows agent** — 同算法 (PBKDF2-SHA256 + 16B salt + 240000 iter + 32-byte output). 同 PIN 两端 hash bit-perfect 相同.
- PinDialog 4-6 位数字输入 + 3 次错锁 30 分钟.
- DashboardScreen "重新配对" 按钮 → 设了 PIN 先验证才放行清 token.

## Android v0.5.13 · 2026-05-14

- **跨端规则匹配 (Win packageName ↔ Android packageName)** — RuleEngine 命中时同时对 CategoryCache 的 LLM display_name 匹配, 让 Win 规则关键词 "微信" / "抖音" 也能在 Android 端命中。

## Android v0.5.12 · 2026-05-13

- **防切换层叠防御** — Foreground Service START_STICKY + WorkManager 15min Watchdog + BootReceiver + AccessibilityService.onUnbind 上报 `accessibility_disabled` 事件 (家长收企微 / SMTP).

## Android v0.5.11 · 2026-05-13

- **国内 ROM 引导卡** — 检测到 MIUI / EMUI / ColorOS / OriginOS 时 Dashboard 显示"打开自启动管理 + 允许后台耗电" 引导.

## Android v0.5.8 · 2026-05-12

- **任务清单 / 申报 UI** — 责任清单 checkbox (走 `checklist_tick` event) + 激励任务点"申报" 弹 ClaimDialog 写备注 (走 `task_claim` 消息).

## Android v0.5.7 · 2026-05-12

- **申请游戏时间 RequestDialog** — Compose AlertDialog 写文字 → `unlock_request` WS 消息 → server 推家长浏览器审批.
- **屏幕灭 5 分钟自动 Lock** — ScreenStateReceiver, 跟 Windows idle_lock 等价.

## Android v0.5.6 · 2026-05-12

- **TokenTicker** — 每分钟一轮 `token_tick` 消息 (跟 Windows `core/token_engine.py` 同协议), server 单一权威扣分 (CLAUDE.md 决策 #34). 5 个条件全满足才发: mode=Child + 非 free_pass + WS Open + 有前台 + 屏幕亮.

## Android v0.5.5 · 2026-05-12

- **CommandHandler** — temporary_unlock / lock_device / start_free_pass / end_free_pass / set_pin / clear_pin 全套.

## Android v0.5.4 · 2026-05-11

- **RuleEngine 移植** — `core/rule_engine.py` Kotlin 版, AND/OR + 5 个 op + exclude + schedule.windows 跨午夜.
- 命中规则 → BlockNotifier + performGlobalAction(GLOBAL_ACTION_HOME) + 上报 block 事件.

## Android v0.5.3 · 2026-05-11

- **CategoryCache + UnknownAppsReporter** — server LLM 分类回流, DataStore 持久化. BootReceiver 监 BOOT_COMPLETED 自启 AgentService.

## Android v0.5.2 · 2026-05-11

- **AccessibilityService + ForegroundAppMonitor** — 监 TYPE_WINDOW_STATE_CHANGED 抓前台 packageName. UsageReporter 每 5min 打包 `usage_report` (跟 Win agent 协议同源).

## Android v0.5.1 · 2026-05-10

- **AgentService Foreground Service + WsClient** — token query 鉴权, hello/heartbeat 30s, 指数退避重连. wallet_update / rules_update 实时刷.

## Android v0.5.0 · 2026-05-10

- **配对页 + 魔法链接 / 8 位码** — POST `/api/devices/pair/redeem` 拿 agent_token. WindowSizeClass 平板自适应.

## Backend v0.4.7 · 2026-05-12

- **每日总结推送 scheduler** — daily_summary_scheduler 每分钟扫 admin_settings, 命中目标时刻给每个 active>0 孩子推今日摘要 (active 时长 + token 净变化 + Top 应用) 走 v0.4.1 notifier.
- dedupe_key=`daily_summary:CHILD:DATE` 防同日重发.

## Frontend v0.4.6 · 2026-05-12

- **多孩子 ChildContext** — Layout 顶部 ChildSwitcher, activeChildId 持久化到 localStorage. Reports / Rules / Tasks / ChildSettings 共用全局 context.

## Frontend v0.4.5 · 2026-05-11

- **/reports CategoryBreakdownCard** — 消遣 / 学习 / 中性 三类横向 bar + 时长占比.

## Frontend v0.4.4 · 2026-05-10

- **/reports 日/周/月三档桶宽** — PG date_trunc 聚合, 周期对比卡 (本期 vs 上一期 active 时长 + token 增减).

## Frontend v0.4.3 · 2026-05-09

- **数据导出** — 5 类数据 (每日聚合 / token 账本 / 应用使用 / 事件日志 / 任务申报) × 2 格式 (CSV / JSON). 365 天上限.

## Backend v0.4.2 · 2026-05-09

- **trust → maturity 自动升档建议** — Lv4/Lv5 时 server 自动发"建议升档"事件 + 通知家长 + Dashboard 横幅. 30 天 cooldown.

## Backend v0.4.1 · 2026-05-08

- **企微 + SMTP notifier 闭环** — 4 类关键事件 (Agent 升级失败 / PIN 多次错 / 设备掉线 >10min / 行为基线异常) 自动推. 5min dedupe.

## Admin v0.4.0 · 2026-05-07

- **独立管理后台** — `admin.{domain}` 子域 + 独立 admin_accounts 表 + JWT kind='admin' 区分. LLM 配置 / Agent 升级包 / 应用分类 / 默认规则 / 系统设置 / 推送 / 租户列表.

## Windows agent v0.3.0 · 2026-05-05

- **无感软件更新** — server 端 agent_releases + Agent 端 SafeMoment 等 Lock 30s + Updater.exe 接管 nssm stop / 替换 / start / 60s 心跳验证 + 失败自动回滚. 详见 CLAUDE.md §22 决策 #39.
