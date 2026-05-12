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
| **P1** | ✅ 模块骨架完成（待联机验证） | 接口先行的本地版 Agent（[`agent/`](agent/)）：监控 + token 经济 + 责任清单 + 自保护 |
| **P2** | 🟡 进行中 | Backend（Node + Postgres）+ React 控制台 + WebSocket 跨端 |
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
│   ├── ui/                   # 托盘图标 + Tkinter 弹窗 (dialogs.py)
│   ├── protector/            # Watchdog + PIN
│   ├── assets/               # 图标资源（从 design/logo.png 生成）
│   ├── config/               # 用户可编辑配置（rules / app_categories / tasks / settings）
│   ├── main.py               # Agent 入口
│   ├── watchdog_main.py      # Watchdog 入口
│   ├── pyinstaller_build.bat # 打包脚本
│   └── install_service.bat   # NSSM 服务注册
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
| `pywin32` | 窗口标题 / 前台进程检测 | 窗口标题匹配失效 + 前台扣分失效 |
| `pynput` | 严格活跃判定（防鼠标抖动器） | 退化为系统级输入检测 |
| `pystray` + `Pillow` | 系统托盘图标 | 无托盘 UI，仅日志可见 |

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

```powershell
cd G:\DEL_GAME
python agent/set_pin.py
```

会让你输两次 PIN，校验一致后用 PBKDF2-SHA256 + 16 字节 salt 加密写入 `agent/config/settings.json`。

PIN 设置后：
- 托盘"退出"会弹 PinDialog，需要正确 PIN 才能关 Agent
- 3 次错误自动锁定 30 分钟
- 未设 PIN 时，"退出"只弹普通确认对话框（开发/初始化阶段方便）

> ⚠ **不要手动改 `pin_hash` / `pin_salt` 字段** —— 那是加密哈希值，
> 直接写明文 PIN 会让验证失败。必须用 `set_pin.py`。
>
> 忘了 PIN：清空 `pin_hash` 和 `pin_salt` 两个字段，再跑 `set_pin.py`。

> 注：`settings.json` 和 `child_profile.json` 不在 git 跟踪范围（含 PIN / 个人信息）。
> 首次启动 Agent 时由 [`agent/store/seed_data.py`](agent/store/seed_data.py) 自动生成默认模板。

### 4. 打包 EXE

```powershell
cd agent
pyinstaller_build.bat
```

产物：`agent/dist/NinoGameAgent.exe` + `agent/dist/Watchdog.exe`

### 5. 注册为 Windows Service（NSSM）

```powershell
# 复制 dist\*.exe 到 C:\Program Files\NinoGame\，然后管理员运行：
cd agent
install_service.bat
```

> ⚠ **Service 模式的关键注意：** NSSM 默认以 LocalSystem 启动，看不到桌面会话。 Agent 需要交互会话才能枚举窗口标题、监听键鼠、弹窗。把 Service 的 "Log On" 改为当前用户，或仅把 Watchdog 做成 Service、Agent 走"开机自启动 + 桌面用户运行"。

------

## P2 基础设施：本地 Postgres

```powershell
cd infra
docker compose up -d
```

启动后：
- 连接：`postgresql://ninogame:ninogame_dev@localhost:5433/ninogame`
- Schema：`NinoGame`（大小写敏感）
- 数据卷：`ninogame-pgdata`

详见 [infra/README.md](infra/README.md)。

------

## 开发约定

1. **接口先行硬约束**：`agent/core/*` 永不直接 `import sqlite3` 或操作文件 / 网络，全部通过 [`agent/store/repository.py`](agent/store/repository.py) 的 ABC 接口。这是 P1→P2 平滑过渡的核心保障。
2. **不做内容过滤 / MDM / 反检测 / 账号生态**（CLAUDE.md §1.4 non-goals）。
3. **LLM 是助手不是裁判**，决策权始终在家长。
4. **每完成重要更新立刻 git commit + push**。

------

## 项目愿景一句话

> 给孩子搭一个能逐步拆除的脚手架。
