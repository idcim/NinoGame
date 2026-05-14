# NinoGame

> 跨端（Windows + Android）的**家长控制 + 自我管理培养**系统。
> 表层：监控并拦截孩子使用未授权的应用。
> 深层：通过 token 经济 / 任务 / 申请审批 / 自我反思工具，让孩子在系统的"脚手架"上逐步学会自我管理。
>
> **设计哲学：让系统逐步退场。** 详见 [CLAUDE.md](CLAUDE.md) §1.2。

------

## 独立管理后台 (v0.4.0+)

家长后台 (`ninogame.{domain}`) 跟运营/超管后台 (`admin.{domain}`) 现在是两个 Docker 服务,
独立 frontend, 独立 JWT (admin token 调不到 parent API, 反之亦然)。

**运营/超管管的事:**
- LLM 配置 (全 server 一份共享, parent 端无入口) — admin 拿 key, 所有家庭自动用
- Agent 升级包上传 / 设为目标 / 删除 — 走 storage 抽象 (local FS / S3 / 阿里云 OSS)
- 全局应用分类 (`app_categories` child_id IS NULL 那批) — admin 修正 LLM 分类 / 加新应用
- 新建 child 默认值 — maturity / quota / 默认拦截规则 seed
- 系统限额 + 当前存储驱动状态
- 推送通道 (企微 webhook + SMTP, v0.4.1 已闭环) — admin 配后关键事件自动推:
  Agent 升级失败 / PIN 多次错 / 设备掉线 >10min / 行为基线异常; 各 channel 有"测试发送"按钮
- 家长账号列表 + 重置密码 + 删除 (CASCADE 谨慎)

**部署 (1Panel 生产):**
- 现 `ninogame-frontend` (家长) 继续反代到 `ninogame.{domain}`
- 新 `ninogame-admin-frontend` 反代到 `admin.{domain}` (1Panel 新建反代站)
- Backend 不变 (一个 Node 进程), 走 `/auth/admin/*` + `/api/admin/*` 给 admin
- **首次启动 bootstrap**: 设 ENV `ADMIN_BOOTSTRAP_USERNAME` + `ADMIN_BOOTSTRAP_PASSWORD`,
  `admin_accounts` 表空时自动写一行 admin; 创建完成后日志会强提醒清空环境变量

**存储驱动 (Storage):**
- 默认 `STORAGE_DRIVER=local` (现状, Docker 卷 `ninogame-artifacts`)
- 切 S3 (`STORAGE_DRIVER=s3` + `S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY` 等) — 同时吃 AWS S3 / MinIO / B2 / R2 / 腾讯 COS / 七牛 (S3 兼容模式)
- 切阿里云 OSS (`STORAGE_DRIVER=aliyun_oss` + `OSS_BUCKET / OSS_REGION / OSS_ACCESS_KEY / OSS_SECRET_KEY`)
- 缺必要 env 时 server 启动告警 + 回退 local; admin /system 页面会显示当前驱动状态

**多租户接缝:** `parents.tenant_id` 列已加, 现在所有 parent 视为 default tenant (`NULL`); 未来切多租户时 backfill 一个固定 UUID 即可。

## 后台运维操作 (新增)

### 设备管理 (设备详情页)
- **重新生成配对码**: 旧 agent_token 立刻作废 (该 Agent 断线), 30 分钟内可在 Agent 端粘贴新码重新配对
- **删除设备**: 整行记录清空, 历史事件保留
- **在线状态 + 在线历史**: 设备卡片实时显示绿/灰圆点 (WS 连接状态), 设备详情页有「在线历史」表 (今日总在线时长 + 每段连/断时间), 数据由 backend `device_online_sessions` 表自动写入 (Agent WS 连/断时触发)
- **后台文案中文化**: maturity_mode / device_type / platform / command_type / action.type / status 等全部走 `frontend/src/lib/labels.ts` 统一映射, 不再出现 "negotiable" / "child_primary" 等英文枚举值

### 数据导出 (v0.4.3+, P4 完成)
- **位置**: 家长后台 /reports 页底部"数据导出"区
- **5 类 × 2 格式**: 每日聚合 / Token 账本 / 应用使用时段 / 事件日志 / 任务申报, 每类有 [CSV] [JSON] 两个下载按钮
- **CSV**: 带 UTF-8 BOM, Excel/WPS/Numbers 直接打开不乱码; JSON 自带 metadata (导出范围 + 行数 + 字段顺序), 脱机分析无需回查 schema
- **时间范围**: 默认跟 /reports 顶部 days (7/14/30) 联动; 支持 `?from=YYYY-MM-DD&to=YYYY-MM-DD` 精确范围; 上限 365 天
- **权限**: 仅家长能拉自家孩子数据 (`ensureOwnership` 校验); 浏览器走 fetch + Bearer + Blob URL + `<a download>` 触发下载, 失败显式弹错不下载乱码文件
- **用途**: 备份 (服务器或硬盘崩了能恢复) / 外部分析 (Excel 透视表 / Python pandas) / 给孩子看具体数字 (CLAUDE.md §1.1 透明可见, §15.6 周回顾的原料)
- **见**: `backend/src/routes/exports.ts`, `frontend/src/pages/Reports.tsx` `ExportSection`

### 自动成熟度升级建议 (v0.4.2+, P4 完成)
- **触发链路**: 每次家长 approve/reject 申请后 server 重算 `trust_level`; 信任值升到 Lv4/Lv5 时根据 §8.7 决策表自动发"建议升档"事件 (Lv4 + strict/negotiable → 建议 `advisory`; Lv5 + advisory → 建议 `self_regulated`)
- **展示**: 浏览器 Dashboard 孩子卡片下方出现🎓"系统建议升级档位"横幅 (信任值徽章 + 升级目标 + 一键应用 / 暂不升级按钮); EventFeed 实时浮出一条"成熟度升级建议"; 配置了企微/SMTP 时 notifier 也同步推 info 级通知
- **不强制**: 家长点"应用" → PATCH `/api/children/:id { maturity_mode }` 把档位升上去, 顺手清除 `dismissed_maturity_target`; 点"暂不升级" → 把当前 target 写入 `dismissed_maturity_target`, 横幅消失
- **防爆**: `children.last_maturity_suggestion_at` 撑 30 天 cooldown, 同 child 30 天内只发一次; "暂不升级"状态 30 天内压住老 target, 但只要系统出新 target (例从 advisory→self_regulated) 立刻清空 dismiss 让新建议过来
- **理念**: CLAUDE.md §1.2 "让系统逐步退场" 的机制化 — 信任值 (P2) 是冷冰冰的数据, 这条把它翻译成"该松手了"的可执行建议; 决策权仍 100% 在家长手里, 系统不当裁判 (§12.5)
- **见**: `backend/src/services/maturity_upgrade_suggester.ts`, `backend/src/routes/children.ts` (PATCH + dismiss 路由 + LATERAL JOIN 拉最新 suggestion), `frontend/src/pages/Dashboard.tsx` (`MaturitySuggestionBanner`)

### Token 调账 / 奖励 (孩子卡片 → 调账/发奖)
- **正数**: 家长酌赠 / 任务奖励 (CLAUDE.md §8.5)
- **负数**: 扣除 / 误扣修正 (§14.5 调账)
- 类型: `parent_grant` / `task_reward` / `adjustment` (记 ledger 时区分)
- 备注: 孩子可见
- 立即推 `wallet_update` 给在线 Agent (本地缓存秒级同步) + 推 `token_credit/deduct` 事件给浏览器实时面板

### 任务管理 (`/tasks`)
- **三个 tab**: 申报队列 (默认, 显示孩子点「我做完了」后待审批) · 任务模板 (按激励/责任分组 CRUD) · 责任清单历史 (7/14/30 天日历视图 + 完成率%)
- **激励任务** (incentive): `name`, `reward_tokens` (≤500), `verification` (家长审批/自报/自动), `schedule` (每日/每周/一次性), `daily_max_completions`; 审批通过会写一笔 `task_reward` ledger 并推 `wallet_update` 给在线 Agent. 拍照证据机制已下线 (改用私下协商 + 家长后台手动 +token, CLAUDE.md §22 #32)
- **责任清单** (responsibility): 强制 `reward_tokens=0` (§8.6), 孩子在 Agent 托盘菜单勾选 → 通过 bus `checklist_tick` 事件传到 server → upsert `responsibility_checks` (按 task+date 唯一)
- **Agent 同步**: 模板增删改后 server 立刻全量推 `tasks_update`; Agent 收到后覆写本地 `config/tasks.json` + 重载 `ResponsibilityChecklist` (responsibility 类立即在托盘菜单刷新)
- **审批拒绝**: 不扣已有余额, 仅标 status=rejected, reward_granted=0; 孩子端目前只在浏览器可见家长意见

### Agent 无感软件更新 (`/releases`, v0.3.0+)
- **思路**: 家长在浏览器 `/releases` 上传新版本 zip → 点"设为目标" → 所有落后 Agent 在孩子 **Lock 态稳定 30s** 时自动下载 + 解压 + 重启, 孩子无感, 失败自动回滚
- **触发链路**: Agent hello 带 `agent_version` → server 写 `devices.agent_version`, 比对 `agent_releases.is_target=TRUE` 行, 落后则入 `commands(command_type='update_self')` + 实时 WS push (离线时 hello_ack 也补)
- **SafeMoment**: Agent 收到 update_self 后缓存 pending, 主循环 30s 一查; 同时满足 `session_manager.mode=='lock'` + 持续 ≥30s + 无任何对话框打开 才动手, 否则等下次
- **Updater.exe**: 独立 PyInstaller onefile (~5MB), 接管文件替换 — 写 `agent_quit.flag` + `watchdog_quit.flag` (复用决策 #36 后的优雅退出机制) → `nssm stop watchdog && nssm stop monitor` → 备份当前 install_dir → xcopy staging → `nssm start` → 60s 内看 `data/agent.alive` + `data/version_marker.txt == to_version` 即成功, 不然回滚
- **防雪崩**: 同版本失败后 6h 内不再重试 (`data/last_update_attempt.json`)
- **签名下载**: `/artifacts/<filename>?token=<jwt>` 走 fastify-static, token 是 server 签的 30 分钟 jwt, 含 device_id + version
- **chicken-and-egg**: v0.2.0 没带 Updater, 升 v0.3.0 还要手动重装一次; v0.3.0 起自动
- **见**: `backend/src/services/agent_release.ts`, `backend/src/routes/admin_releases.ts`, `agent/updater.py`, `agent/services/updater_kick.py`, `frontend/src/pages/Releases.tsx`

### 规则一句话生成 (`/rules` 顶部)
- **输入框**: 家长打一句话 ("禁止玩原神" / "晚上 9 点后不让玩王者荣耀" / "工作日不能玩 Minecraft") → 调 `POST /api/rules/draft-from-text` → LLM 翻译成 `RuleDraft` (name + 关键词列表 + action + schedule)
- **不直接落库**: 后端返 draft, 前端打开 RuleEditor 预填字段, 家长再调 (改关键词/动作/时段) 后点保存才真正 INSERT — 保留人工兜底, LLM 不当裁判 (§12.5)
- **降级**: LLM 未配置 / 调用失败 → 422 + "请去 /llm-config 配置, 或手动新建规则"
- **关键词去重**: LLM 提示词强制全小写 + 中英文别名; 后端 normalize 屏蔽 chrome.exe/explorer 等通用进程, 防误拦
- **见**: `backend/src/services/llm_rule_translator.ts`, `frontend/src/pages/Rules.tsx`

### 使用报表应用友好名 (`/reports` → Top 应用)
- **预置 80+ 常见 Windows 进程**: 浏览器/办公/游戏/视频/IDE 等开箱即有中文/英文友好名 (`chrome.exe` → "Google Chrome", `bilibili.exe` → "哔哩哔哩", `code.exe` → "Visual Studio Code"), 见 `backend/sql/1747095500000_app_display_name.sql`
- **LLM 自动补齐**: 未知 exe 进 `unknown_apps_queue` → server `classifyApp` 同时让 LLM 出 `display_name` + category, 写回 `app_categories.display_name`, 推 Agent (`app_categories_update`); LLM 未配置时退回 seed/裸进程名
- **家长可覆写** (未来): `app_categories.classification_source='parent'` 优先级最高 (LATERAL JOIN 选孩子 override > 全局)
- **顺手修了老坑**: `UNIQUE(app_identifier, child_id)` 对 `child_id IS NULL` 不生效 (PG NULL ≠ NULL), 老代码 `ON CONFLICT DO NOTHING` 静默插入全局重复行; 迁移先清重再加 `idx_app_categories_global_unique` partial unique index

### Agent 端任务申报 (孩子端 UX)
- **入口**: 托盘菜单 (child 模式) 看到「申报任务完成…」, 点开弹 TaskClaimDialog
- **列表**: 读本地 `config/tasks.json` 中所有 `category=incentive` 且 `active=true` 的任务, 每行显示 任务名 + verification 提示 + `+N token` 徽章 + 「申报完成」按钮
- **备注**: 可选 (256 字), 家长在浏览器 /tasks 申报队列里看得到
- **WS 上报**: 点按钮发 `{type:"task_claim", payload:{task_id, child_note}}`, server 端 onTaskClaim 写 `task_completions(status=pending)`
- **批准通知**: 家长在浏览器 /tasks 审批后, server 推 `wallet_update {reason:"task_reward", delta:+N}`, Agent 弹原生通知 "+N token 到账" (家长发奖 `parent_grant` 同理)
- **未配对/掉线**: 按钮发送失败时 dialog 显示提示, 不静默丢消息

## 后续计划 (P2 收尾 / P3)

| 优先 | 事项 | 形态 |
|---|---|---|
| ✅ | ~~配对体验优化~~ | Agent GUI 配对对话框（托盘"重新配对家长后台"）+ 一键复制魔法链接（`URL/#pair=CODE`）+ 智能粘贴解析 |
| ✅ | ~~规则编辑页~~ | 浏览器 `/rules` 页面: 增删改 + 启用/禁用 toggle, 保存即推送 WS rules_update; Agent 立即更新本地 rules.json |
| ✅ | ~~每日基础发放搬服务端~~ | server `ensureTodayGrant` 行锁 + 事务 + 幂等 (按 PG `CURRENT_DATE`); Agent 配对后 hello_ack 触发, 离线时 fallback 到本地 |
| ✅ | ~~usage_report 服务端聚合~~ | Agent 端 UsageReporter 周期上报未同步 segments → server INSERT `NinoGame.app_sessions` (按 app+category 聚合) |
| ✅ | ~~申请-审批流（§13）~~ | Agent 端「申请游戏时间」对话框 → WS 上报 → 家长浏览器 /requests 一键批准 (10/30/60 分钟) → 自动 push temporary_unlock |
| ✅ | ~~信任值机制（§8.7）~~ | server `recomputeTrust` 在每次审批后异步触发: 30 天窗口 ≥5 样本, reject_rate >30%→ -1, <5%→ +1; 24h 冷却; 写 `trust_changes` ledger; frontend 卡片显示星级 |
| ✅ | ~~鼠标轨迹防刷（§16）~~ | Agent 端 JigglerDetector: 每 1s 采样 cursor, 60s 窗口 bounding box <80px 判定机械感 → is_active_earning 返回 False (不刷分) + 发 JIGGLER_ALERT 事件 (家长浏览器实时看到, 5min 限频) |
| ✅ | ~~任务管理 (§8.3 Path 3 + §8.6 责任清单)~~ | 浏览器 `/tasks` 页面: 模板 CRUD + 申报队列 (待审批/已批/已拒) + 责任清单 14/30 天历史日历; server `tasks_update` 全量推 → Agent 写本地 `tasks.json` + 重载 checklist; 责任勾选走 `event:checklist_tick` → server upsert `responsibility_checks`; 激励任务 approve 自动走 `task_reward` ledger + 推 `wallet_update` |
| ✅ | ~~Agent 端激励任务申报 UI~~ | 托盘菜单 (child 模式) →「申报任务完成…」→ 列出本地 `tasks.json` 中所有 active+incentive 任务, 一行一个「申报完成」按钮 + 可选备注 → 发 `task_claim` WS → server 写 pending + 推家长浏览器; 家长批准后 `wallet_update` 推回 Agent, Agent 弹通知"+30 token 到账" |
| ✅ | ~~限免活动 (§14.4)~~ | 设备详情页「限免 30 分 / 1 小时 / 2 小时」一键; backend `POST /api/free-pass` 写 `free_pass_periods` + push `start_free_pass` 到该孩子所有在线 Agent; Agent 期间 consumption 跳扣 token (规则仍生效); 浏览器实时显示倒计时 + 终止按钮; Agent 重连 hello_ack 带活跃段, 重启不丢限免态 |
| ✅ | ~~行为基线异常告警 (§16.1 ④)~~ | server 后台调度器每小时跑一次 `scanAllChildrenBaseline`: 按 `child × category` 拉过去 14 天每天 `active_seconds` 算均值, 今日 >2x 均值 (且 >30 min, 样本天数 ≥5) 触发, 写 `events(event_type='behavior_anomaly')` + push 给该家长浏览器实时面板; 单 child+category 24h 限频。"不阻止使用, 只是提醒" |
| ✅ | ~~时间窗口规则 (§9.1 schedule.windows)~~ | 规则编辑器加"生效时段"区: 始终生效 / 仅指定时段 / 暂停。"仅指定时段"可加多段窗口, 每段挑星期 + HH:MM 起止 (跨午夜支持)。Agent rule_engine 按本地 wall-clock 判定, 任一窗口命中即生效; 列表卡片展示概要 ("工作日 21:00-23:00")。Zod 严格校验 from/to 格式 + days ∈ [0..6]。 |
| ✅ | ~~自动 maturity_mode 升级建议 (P4)~~ | trust_level 升到 Lv4/Lv5 时 server 自动发"建议升档"事件 (Lv4 + strict/negotiable → advisory; Lv5 + advisory → self_regulated); 写 events + 推浏览器横幅"一键应用 / 暂不升级" + notifier (info 级). 30 天 cooldown + dismiss 标记. CLAUDE.md §1.2 让系统逐步退场的机制化, §22 #43. |
| 🟢 | **Android Agent** | Kotlin + AccessibilityService |

## 当前状态

| 阶段 | 状态 | 内容 |
|---|---|---|
| **P0** | ✅ 完成 | 本地单文件脚本 [`pvz_monitor.py`](pvz_monitor.py)：PvZ 全变种关键词拦截 |
| **P1** | ✅ 完成（含打包验证） | 接口先行的本地版 Agent（[`agent/`](agent/)）：监控 + token 经济 + 责任清单 + 自保护 + PyInstaller exe |
| **P2** | 🟢 主要功能就绪 | Backend + Frontend + Postgres 三容器 docker compose，远控命令、临时解锁、实时事件流、PIN 远程设置 全通 |
| **P3+** | ⏳ 待规划 | LLM 集成、Android App、跨端钱包同步 |

完整设计文档（路线图、配额档位、防滥用机制、决策记录）：[CLAUDE.md](CLAUDE.md)

------

## 仓库结构

```
DEL_GAME/
├── pvz_monitor.py            # P0 单文件版（仍可独立运行作为应急方案）
├── CLAUDE.md                 # 完整设计文档（项目唯一权威来源）
├── README.md                 # 本文件
│
├── design/                   # 设计稿
│   └── logo.png              # 主 logo（树+秋千+NinoGame）
│
├── agent/                    # P1 Windows Agent
│   ├── core/                 # 业务模块（monitor / rule_engine / killer / token_engine / messages / ...）
│   ├── store/                # 存储层（ABC 接口 + SQLite 实现 + schema.sql）
│   ├── comms/                # 消息类型 + 事件总线 + Transport 抽象
│   ├── ui/                   # 托盘图标 + Qt 弹窗 (qt_dialogs.py + qt_bridge.py)
│   ├── protector/            # Watchdog + PIN
│   ├── assets/               # 图标资源（从 design/logo.png 生成）
│   ├── config/               # 用户可编辑配置（rules / app_categories / tasks / settings）
│   ├── main.py               # Agent 入口 (Qt 事件循环主线程)
│   ├── set_pin.py            # 家长 PIN 设置脚本
│   ├── watchdog_main.py      # Watchdog 入口
│   ├── pyinstaller_build.bat # 打包脚本
│   └── install_service.bat   # NSSM 服务注册
│
├── backend/                  # P2 Backend (Node + Fastify + Postgres)
│   ├── src/                  # config / db / server / index / routes / ws
│   ├── sql/                  # node-pg-migrate SQL migrations
│   ├── Dockerfile            # multi-stage build
│   └── README.md             # 启动 / migration / 部署说明
│
├── frontend/                 # P2 家长后台 (React + Vite + Tailwind)
│   ├── src/                  # pages / components / lib (api + auth)
│   ├── public/               # logo + favicon
│   └── README.md             # 启动 / 构建说明
│
└── infra/                    # 本地基础设施
    ├── docker-compose.yml    # Postgres 15（P2 后端用）
    ├── postgres-init/        # 容器首次启动初始化 SQL
    └── README.md             # 启停说明
```

------

## P1 Agent：本地开发

### 1. 安装依赖

```powershell
cd G:\DEL_GAME
pip install -r agent/requirements.txt
```

依赖清单（[agent/requirements.txt](agent/requirements.txt)）：

| 包 | 用途 | 不装的后果 |
|---|---|---|
| `psutil` | 进程枚举 | **必需，不装无法启动** |
| `PySide6 6.6.x` | 弹窗 UI (PIN 输入 / 警告 / 确认) | **必需** |
| `pywin32` | 窗口标题 / 前台进程检测 | 窗口标题匹配失效 + 前台扣分失效 |
| `pynput` | 严格活跃判定（防鼠标抖动器） | 退化为系统级输入检测 |
| `pystray` + `Pillow` | 系统托盘图标 | 无托盘 UI，仅日志可见 |

> ⚠ **PySide6 版本钉到 6.6.x**：6.11+ 在 Anaconda / 部分 Win10 环境有 DLL load 问题。
> 如果 `pip install PySide6` 装的是 6.11 报错，回退到 `pip install "PySide6==6.6.3"`。

### 2. 运行

```powershell
python agent/main.py
```

**如果 pip install 后仍然提示 `pywin32 未安装`**（常见于 conda / 多 Python 环境）：

```powershell
python -m pip install --force-reinstall pywin32
# 然后用管理员 PowerShell 运行 pywin32 的 post-install 脚本注册 DLL：
python "$((python -c 'import sys; print(sys.prefix)'))\Scripts\pywin32_postinstall.py" -install
```

启动后会看到：

```
============================================================
NinoGame Agent 启动中; root=G:\DEL_GAME\agent
============================================================
今日基础发放: +30 token
当前钱包余额: 30 token
启动 activity_detector ...
启动 session_manager (初始模式=child) ...
启动 token_engine ...
启动 self_protector ...
启动 tray_icon ...
────────────────────────────────────────────────────────────
Agent 已就绪 | 规则数=1 | 扫描间隔=2s | Ctrl+C 退出
────────────────────────────────────────────────────────────
心跳 | mode=child | balance=30 | 最近 60s: 扫描 30 次, 拦截 0 个
...
```

Agent 启动后默认进入 `child` 模式，闲置 10 分钟自动 Lock。在 `child` 模式下：
- 任何 PvZ 变种进程出现 → kill + 弹窗
- 前台是消费类应用 + 用户活跃 → 每分钟扣 token
- 前台是生产类应用（VSCode / Kindle / 学习类）+ 严格活跃 → 每分钟赚 token，按日上限封顶
- 右上角浮层常驻显示余额（qtawesome 矢量图标 + 文字），三态切换：
  - 钻石 + 数字 + 时钟"N 分钟剩余"（消费中，颜色按余额绿→黄→橙→红）
  - 钻石 + 数字 + 学士帽"正在学习"（学习类前台）
  - 钻石 + 数字 + 云"余额"（中性 / 桌面 / 闲置）
- **托盘单击 / 双击** → 弹"状态面板"：大号余额 + 当前模式徽章 + 今日花费 / 挣到 / 游戏分钟 / 责任清单 + 锁定/解锁按钮
- 托盘菜单（全中文）：打开状态面板 · 立即锁定 · 解锁使用 · 余额浮层切换 · 责任清单 · 退出（家长验证）

### 性能说明

进程枚举走 Windows Toolhelp32 (CreateToolhelp32Snapshot)，单次扫描约 **10ms**（400+ 进程的机器）。psutil 同样操作要 ~1100ms（因为它对每个进程都 OpenProcess）。默认扫描周期 5s，CPU 占用近乎零。

**升级老版本时**：如果你之前的 `settings.json` 有 `monitor_scan_interval_seconds: 2`，老版本会卡。手动改成 5（或更大），或直接删了 `settings.json` 让 seed_data 重新生成。

### pynput 引起的输入延迟

`pynput` 用 Windows 低级键鼠 hook（WH_KEYBOARD_LL）来识别"鼠标抖动器"。在部分机器上会让全局键鼠响应变慢。在 `settings.json` 关掉：

```json
"strict_input_detection_enabled": false
```

代价：鼠标抖动器无法被识别（防刷 ① 降级到 Windows GetLastInputInfo，鼠标位移也算活跃）。

### 3. 修改规则 / 配置

直接编辑 JSON：

| 文件 | 作用 |
|---|---|
| [`agent/config/rules.json`](agent/config/rules.json) | 进程拦截规则（matchers + action） |
| [`agent/config/app_categories.json`](agent/config/app_categories.json) | App 分类（consumption / neutral / productive） |
| [`agent/config/tasks.json`](agent/config/tasks.json) | 任务 / 责任清单 |
| [`agent/config/settings.json`](agent/config/settings.json) | 档位、PIN、闲置阈值、**所有 UI 文案** |

`rules.json` 改动是**热加载**的（无需重启 Agent）；其他配置改完重启 Agent。

#### 自定义提示文案

`settings.json` 的 `messages` 段里所有 key 都可改，支持占位符：

```json
{
  "messages": {
    "block_rule_default": "Nino, 这个游戏需要先和爸爸商量哦。",
    "block_daily_cap": "今天的游戏配额用完了。\n剩余 {balance} token 留给明天。",
    "block_out_of_balance": "Token 用光了。完成任务挣分再来。",
    "quit_prompt_pin": "请输入家长 PIN 才能停掉监控。",
    "tray_tooltip": "NinoGame · {mode} · {balance} token"
  }
}
```

支持的占位符：`{balance}` `{used_minutes}` `{cap_minutes}` `{process_name}` `{rule_name}` `{remaining}` `{minutes}` `{mode}`。
完整 key 列表见 [`agent/core/messages.py`](agent/core/messages.py) 的 `DEFAULTS`。

#### 设置家长 PIN

三种方式都可以：

```powershell
# 方式 1: 交互式 (两次校验，屏幕不显字符)
python agent/set_pin.py

# 方式 2: 一行命令
python agent/set_pin.py 1234

# 方式 3: 直接编辑 agent/config/settings.json, 把 pin_hash 写成明文 PIN
#         Agent 下次启动会自动加密保存
{
  ...
  "pin_hash": "1234",
  ...
}
```

PIN 设置后：
- 托盘"退出"会弹 PinDialog，需要正确 PIN 才能关 Agent
- 3 次错误自动锁定 30 分钟
- 未设 PIN 时，"退出"只弹普通确认对话框（开发/初始化阶段方便）

> 忘了 PIN：清空 settings.json 里 `pin_hash` 和 `pin_salt` 两个字段，再跑 `set_pin.py`。

> 注：`settings.json` 和 `child_profile.json` 不在 git 跟踪范围（含 PIN / 个人信息）。
> 首次启动 Agent 时由 [`agent/store/seed_data.py`](agent/store/seed_data.py) 自动生成默认模板。

### 4. 打包

```powershell
cd agent
pyinstaller_build.bat
```

产物（**folder 模式**，启动瞬时不解压）：

```
agent/dist/NinoGameAgent/
├── NinoGameAgent.exe         # ~3 MB 引导
├── Watchdog.exe              # ~7 MB 单文件
├── _internal/                # ~120 MB Qt + 依赖
└── assets/                   # 图标
```

**安装方式**：把整个 `dist/NinoGameAgent/` 文件夹拷到 `C:\Program Files\NinoGame\`（或别处）。整个文件夹要原样保留，**不能只拷 .exe**。

> ⚠ **pathlib backport 冲突**：如果 PyInstaller 报 `'pathlib' is an obsolete backport`，
> 跑 `pip uninstall -y pathlib` 后重试。Anaconda 老版本里 pathlib 是 standalone 包，
> 跟新 PyInstaller 不兼容。

> ⚠ **"Failed to start embedded python interpreter!"**（运行打出来的 exe 时弹窗）：
> PyInstaller bootloader 启动 Python 运行时失败。按下面顺序排查：
>
> 1. **重装 PyInstaller**：`pip install --upgrade --force-reinstall pyinstaller`
>    然后重跑 `pyinstaller_build.bat`（脚本已带 `--clean`）
> 2. **缺 VC++ 运行时**：装 [VC Redist x64](https://aka.ms/vs/17/release/vc_redist.x64.exe)
> 3. **杀毒/Windows Defender** 删了 bootloader：检查隔离区
> 4. **用 python.org 的 CPython 替代 Anaconda**（Anaconda 偶尔触发该 bug）：
>    `winget install Python.Python.3.11` 后用它建 venv 再打包

> 为什么不用 `--onefile`：单文件版每次启动都要把 270MB 解压到 `%TEMP%\_MEIxxxxx\`，
> 启动需要 2-3 秒，且产生孤儿临时文件夹。folder 模式启动近瞬时。

### 单实例

Agent 用 Windows 命名 mutex (`Local\NinoGameAgent_SingleInstance_v1`) 防止双击启动出两个进程。第二次启动会立即退出（控制台打印 `已有一个 Agent 实例在运行`），托盘里依然只有第一个进程。Watchdog 同理用 `Local\NinoGameWatchdog_SingleInstance_v1`。

打包验证过的事项：
- exe 双击启动 → 自动在旁边建 `data/` + `config/`
- 启动只 1 个 NinoGameAgent.exe 进程（onefile 模式会有 bootloader + 子进程 2 个）
- 第二次双击被 mutex 挡掉，进程列表不变
- self_protector 发现 Watchdog.exe 不在 → 自动 Popen 拉起
- 心跳文件 `agent.alive` / `watchdog.alive` 正常更新

### 5. 注册为 Windows Service（NSSM）

```powershell
# 复制 dist\*.exe 到 C:\Program Files\NinoGame\，然后管理员运行：
cd agent
install_service.bat
```

> ⚠ **Service 模式的关键注意：** NSSM 默认以 LocalSystem 启动，看不到桌面会话。 Agent 需要交互会话才能枚举窗口标题、监听键鼠、弹窗。把 Service 的 "Log On" 改为当前用户，或仅把 Watchdog 做成 Service、Agent 走"开机自启动 + 桌面用户运行"。

------

## 家长操作: 临时放行 PvZ

**推荐方式**：浏览器打开家长后台。先起 backend + frontend：

```powershell
cd infra && docker compose up -d        # backend + db
cd ..\frontend && npm install && npm run dev    # 前端 dev server :5173
```

打开 http://127.0.0.1:5173/ → 注册家长 → 创建孩子 → 生成配对码 → Agent 端 `pair.py` 兑换 → 设备列表点进去 → 「放行 30 分钟」按钮一点即可。

### 远程设置 PIN

家长在设备详情页点「设置 / 重置 PIN」→ 输入两次 PIN → 推送命令。Agent 收到后用 PBKDF2-SHA256 加密保存到本地 `settings.json`，并弹通知"PIN 已更新"。不需要触碰孩子的电脑。

`clear_pin` 命令把 PIN 清空，Agent 退出回退到普通确认框（无密码）。

### 或: 用 curl (无 UI 时)

```powershell
# 1) 登录拿 token
$BASE = "http://127.0.0.1:8088"      # 或线上 https://ninogame.你的域名
$resp = curl -s -X POST $BASE/auth/parent/login -H "Content-Type: application/json" -d '{"username":"你","password":"密码"}' | ConvertFrom-Json
$TOKEN = $resp.token

# 2) 找孩子的设备 id
$DEVICE_ID = (curl -s "$BASE/api/devices" -H "Authorization: Bearer $TOKEN" | ConvertFrom-Json).devices[0].id

# 3) 推送 "解锁 PvZ 30 分钟"
curl -X POST "$BASE/api/commands" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $TOKEN" `
  -d "{\"device_id\":\"$DEVICE_ID\",\"command_type\":\"temporary_unlock\",\"payload\":{\"rule_id\":\"rule_pvz_all\",\"duration_seconds\":1800}}"
```

Agent 日志会看到：
```
处理 command: type=temporary_unlock payload={'rule_id':'rule_pvz_all','duration_seconds':1800}
★ 临时解锁: rule_id=rule_pvz_all 直到 ... (持续 1800 秒)
```

解锁期间：
- PvZ 不再被 kill
- token_engine 按 consumption + 1.5x 费率**实时扣 token**（PvZ 每分钟 1.5 token）
- 到期后规则自动恢复拦截

其它 command 类型：
| command_type | 作用 |
|---|---|
| `temporary_unlock` | 临时解锁一条规则（payload: rule_id + duration_seconds/minutes）|
| `lock_device` | 立即切到 Lock 模式 |
| `start_free_pass` / `end_free_pass` | P3 限免活动 |

## Agent ↔ Backend 联机

P2 已打通 Agent 端的 `WebSocketTransport`。配对流程：

```powershell
# 1) 启动 Backend (一次)
cd backend && npm run dev

# 2) 家长后台拿配对码 (用 curl 或将来的 Web UI)
# 登录 → 创建孩子 → POST /api/devices/pair 拿 8 位码

# 3) Agent 设备跑 pair.py 输入码
cd ..
python agent/pair.py http://后端IP:8088 ABCDEFGH
# 它会把 agent_token / device_id / child_id 写进 agent/config/settings.json

# 4) 启动 Agent
python agent/main.py
# 日志会看到:
#   使用 WebSocketTransport: ws://后端IP:8088/ws/agent
#   WS 已连接
#   WS 已连; 发 hello
#   收到 hello_ack: server rules=N, wallet=N, pending_cmds=N
```

之后 Agent 端 BLOCK / SESSION_OPEN / TOKEN_DEDUCT 等事件自动转发到 server，落 `NinoGame.events` 表。

**Server 推 → Agent 落地（已实现）：**
- `hello_ack.rules` / `rules_update`：覆盖本地 `config/rules.json`，规则引擎下个 tick 用新规则
- `hello_ack.wallet_balance` / `wallet_update`：写一笔 `reason=server_sync` 的 ledger 同步本地余额

`settings.json` 没配 `backend_url` 或 `agent_token` → 使用 `NullTransport` 离线模式（P1 行为不变）。

### 数据归属

| 数据 | 权威源 | 本地角色 |
|---|---|---|
| 钱包余额 | **Server** | Agent 本地是 cache; sync_balance 强制对齐 server 值 |
| **token 扣费** | **Server**（onUsageReport 据 usage_report 减 + push wallet_update）| Agent 仅显示, 不动权威账本 |
| **每日基础发放** | **Server**（hello_ack 触发 ensureTodayGrant, 24h 幂等）| Agent 离线 fallback |
| ledger 长期账本 | **Server** | Agent 本地 ledger 仅离线缓冲 |
| 规则 rules | **Server** | 缓存到 `config/rules.json` |
| app_categories | **Server**（全局）| 缓存 7 天 |
| events / sessions / app_segments | Agent 产 → **Server** 长期存 | 写缓冲，离线时排队上报 |
| settings.json（PIN / URL / token / 文案）| 本地 | 本地，不外发 |
| heartbeat 文件（agent.alive / watchdog.alive）| 本地 | 本地，自保护用 |

**核心原则**：Agent 配对后 token 经济权威源 100% 在 server。Agent 本地的 `wallet.balance` 和 ledger 仅作为离线时的缓冲，连上后 server 推 `wallet_update` 即对齐。

## P2 Backend：本地开发

### 1. 启动 Postgres (docker)

```powershell
cd infra
docker compose up -d
```

监听 `127.0.0.1:5433`, schema `NinoGame`。详见 [infra/README.md](infra/README.md)。

### 2. 启动 Backend dev server

```powershell
cd backend
npm install
copy .env.example .env
npm run migrate:up    # 一次性, 建所有 21 张表
npm run dev           # tsx watch, 改代码自动重启
```

验证：
```powershell
curl http://127.0.0.1:8088/health
# {"status":"ok","env":"development","uptime_seconds":3,"db":{...,"version":"PostgreSQL 15.17"}}
```

详见 [backend/README.md](backend/README.md)。

------

## 开发约定

1. **接口先行硬约束**：`agent/core/*` 永不直接 `import sqlite3` 或操作文件 / 网络，全部通过 [`agent/store/repository.py`](agent/store/repository.py) 的 ABC 接口。这是 P1→P2 平滑过渡的核心保障。
2. **不做内容过滤 / MDM / 反检测 / 账号生态**（CLAUDE.md §1.4 non-goals）。
3. **LLM 是助手不是裁判**，决策权始终在家长。
4. **每完成重要更新立刻 git commit + push**。

------

## 项目愿景一句话

> 给孩子搭一个能逐步拆除的脚手架。
