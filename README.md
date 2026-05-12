# NinoGame

> 跨端（Windows + Android）的**家长控制 + 自我管理培养**系统。
> 表层：监控并拦截孩子使用未授权的应用。
> 深层：通过 token 经济 / 任务 / 申请审批 / 自我反思工具，让孩子在系统的"脚手架"上逐步学会自我管理。
>
> **设计哲学：让系统逐步退场。** 详见 [CLAUDE.md](CLAUDE.md) §1.2。

------

## 当前状态

| 阶段 | 状态 | 内容 |
|---|---|---|
| **P0** | ✅ 完成 | 本地单文件脚本 [`pvz_monitor.py`](pvz_monitor.py)：PvZ 全变种关键词拦截 |
| **P1** | ✅ 完成（含打包验证） | 接口先行的本地版 Agent（[`agent/`](agent/)）：监控 + token 经济 + 责任清单 + 自保护 + PyInstaller exe |
| **P2** | 🟡 进行中 | Backend（Node + Fastify + Postgres，[`backend/`](backend/)）已起骨架 + §18 全 21 张表，待写 REST/WS/Auth |
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
│   ├── src/                  # config / db / server / index
│   ├── sql/                  # node-pg-migrate SQL migrations
│   ├── package.json
│   └── README.md             # 启动 / migration / 部署说明
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
- 前台是消费类时，屏幕右上角浮层显示 `💎 余额 / ⏱ 剩余分钟`，颜色随余额变化（绿→黄→橙→红）。可在托盘菜单关闭。

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
