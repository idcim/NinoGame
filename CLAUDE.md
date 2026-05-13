# NinoGame — 家长控制与自我管理培养系统

> **项目代号：** NinoGame **当前状态：** P0 完成（本地脚本），P1 模块骨架完成（待联机验证） **文档版本：** v0.4 **最后更新：** 2026-05-13

------

## 0. 文档导航

| 章节  | 内容                                                   |
| ----- | ------------------------------------------------------ |
| §1    | 项目愿景与设计哲学                                     |
| §2    | 整体架构                                               |
| §3    | 账号与身份体系                                         |
| §4    | 设备所有权与角色切换                                   |
| §5    | 成熟度档位（Maturity Mode）                            |
| §6    | 配额档位（Quota Package）                              |
| §7    | Token 经济模型                                         |
| §8    | 赚分路径（5 路径 + 责任 checklist + 信任值）           |
| §9    | 规则引擎与检测系统                                     |
| §10   | 会话与计费模型                                         |
| §11   | 跨端同步                                               |
| §12   | LLM 集成                                               |
| §13   | 协商与审批流程                                         |
| §14   | 家长后台                                               |
| §15   | 孩子端可视化与自我管理                                 |
| §16   | 防滥用机制                                             |
| §17   | 自保护                                                 |
| §17.5 | **Agent 实施架构（目录/接口/SQLite Schema/推进顺序）** |
| §18   | 数据模型                                               |
| §19   | 通信协议                                               |
| §20   | 构建与部署                                             |
| §21   | 阶段路线图                                             |
| §22   | 全部决策记录                                           |
| §23   | 给后续 Claude 实例的工作指引                           |

------

## 1. 项目愿景与设计哲学

### 1.1 这是什么

NinoGame 是一套跨端（Windows + Android）的**家长控制 + 自我管理培养**系统。表层功能：监控并拦截孩子使用未授权的应用（首期场景：植物大战僵尸全变种）。深层功能：通过 token 经济、任务系统、申请审批、自我反思工具，让孩子在系统的"脚手架"上逐步学会自我管理。

### 1.2 核心设计哲学：让系统逐步退场

**这套系统的真正目标不是长期控制孩子，而是让自己逐步退场。**

一个永远不退场的控制系统会把孩子训练成"如何对抗系统"。NinoGame 的最终目标是让 Nino 在 16 岁前后能自己掌控时间分配，那么这个软件本质上是**临时脚手架**。

具象化为四档**成熟度模式**（详见 §5）：

- `strict`（6-9 岁）→ 家长决定
- `negotiable`（10-13 岁）→ 协商
- `advisory`（13-16 岁）→ 软干预
- `self_regulated`（16+）→ 自我管理工具

同一套代码服务整个成长周期，UI 与权限随档位演化。

### 1.3 玩与教的调和

系统的核心张力是「控制力」与「自主性」。NinoGame 的设计取向：

1. **结构是脚手架，不是牢笼** —— 像训练轮，目标是被卸下
2. **可见性优于强制力** —— 孩子能看见规则、可协商、可申请
3. **协商接口而非控制器** —— 让家庭沟通**变得低摩擦**，而不是被技术阻断
4. **机制承载价值观** —— token 费率系数、信任值机制等本身就传达价值
5. **承认系统有边界** —— 学校设备、朋友家电脑、网页云游戏等场景管不到，靠对话不靠技术

### 1.4 Non-goals

- **不做内容过滤**（网址黑名单、浏览器拦截）—— 浏览器层面有现成方案
- **不做完整 MDM**（屏幕监控视频流、键盘记录）—— 隐私和复杂度都太高
- **不做反检测 / 隐藏化** —— 不走"装成系统进程""注入 explorer"这类路子，保持透明可审计
- **不做账号生态** —— 自用工具，不做 SaaS
- **不强制覆盖所有设备** —— 跟着孩子主用设备走，家长主用设备不监控
- **不替代家庭沟通** —— 系统是协商工具，不是判官

------

## 2. 整体架构

### 2.1 组件全景图

```
┌─────────────────────────────────────────────┐
│           家长端：Web 控制台                  │
│      (React + Tailwind, 移动端响应式)        │
│  设备 / 规则 / 任务 / 事件 / 调账 / 限免      │
└────────────────────┬────────────────────────┘
                     │ HTTPS / REST
┌────────────────────▼────────────────────────┐
│                  Backend                    │
│   Node.js + PostgreSQL + ws                 │
│   （1Panel 管理，内部端口，OpenResty 反代）  │
│   ├─ 认证：家长账号 + 孩子账号 + 设备绑定    │
│   ├─ REST：各资源 CRUD                       │
│   ├─ WebSocket：与 Agent 长连接              │
│   ├─ LLM Service：翻译/分类/验证             │
│   └─ Notifier：企业微信机器人推送            │
└──────┬──────────────────────────────────┬───┘
       │ WebSocket (wss://)               │ wss://
┌──────▼──────────────────────┐    ┌──────▼──────────────────┐
│  Windows PC: Agent.exe       │    │  Android: NinoGame App  │
│  + Watchdog.exe              │    │  (AccessibilityService) │
│  PyInstaller 打包 + Service   │    │  Kotlin 原生            │
└─────────────────────────────┘    └─────────────────────────┘
                     ↑                            ↑
                     └──── 同一孩子账号同步 ──────┘
                          (token / 规则 / 事件)
```

### 2.2 技术栈选型

| 层       | 技术                                            | 理由                 |
| -------- | ----------------------------------------------- | -------------------- |
| Backend  | Node.js + Fastify                               | 复用 三个管家 现有栈 |
| 数据库   | PostgreSQL 15 (schema: `NinoGame`)              | 复用现有实例         |
| 反代     | 1Panel 的 OpenResty（域名 `NinoGame.{现域名}`） | 复用 1Panel 管理     |
| 实时通信 | WebSocket（`ws` 库）                            | 双向、低延迟         |
| PC Agent | Python 3.11 + psutil + pywin32                  | P0 已选定，平滑演进  |
| PC 打包  | PyInstaller + NSSM                              | 成熟方案             |
| Android  | Kotlin + AccessibilityService                   | 原生最稳             |
| 控制台   | Vite + React + TailwindCSS + shadcn/ui          | 现代化、移动友好     |
| LLM      | Anthropic Claude API（首选） / 国内备选         | 翻译/分类质量优先    |
| 推送     | 企业微信机器人 webhook                          | 你已经在用           |

------

## 3. 账号与身份体系

### 3.1 账号层级

```
家长账号 (Parent)
├── 家庭设置 (档位 / 推送 / 计费偏好)
├── 孩子 A (Child)
│   ├── 个人钱包 (token 余额 + ledger)
│   ├── 任务列表 (模板 + 完成记录)
│   ├── 规则集 (从家长配置继承+定制)
│   └── 设备 (PC, 手机, ...)
│       ├── Windows-Laptop-001 (child_primary)
│       └── Android-Phone-001 (child_primary)
└── 孩子 B (Child)
    └── ...
```

**关系约束：**

- 一个家长可管理多个孩子（v1 简化）；P3+ 支持双亲共管
- 一个孩子归属一个家长
- 一台设备归属一个孩子（共享设备特殊处理见 §4）
- 钱包、任务、规则按孩子隔离，孩子间不可见

### 3.2 孩子账号认证（三层组合）

**Layer 1：Username + PIN**

- 家长在后台创建（如 `nino` + 6 位 PIN）
- PIN 由家长设置或孩子自选，家长可见可重置
- 不用邮箱、不用强密码——孩子记不住、容易共享

**Layer 2：设备绑定后免日常登录**

- 首次绑定：PIN + 家长生成的一次性配对码
- 绑定后该设备认 Nino 为"主人"，开机进入 Nino 会话
- 设备绑定可被家长后台远程解除

**Layer 3：关键操作二次确认**

- 大额 token 花销（>100 token 一次性）
- 申请超长时长（>1 小时）
- 切换出 Parent Mode 回 Child Mode
- 这些必须重新输 PIN

### 3.3 PIN 错误锁定

- 连续 3 次输错 → 锁定 30 分钟
- 锁定期间任何输入无效
- 同时向家长推送告警："Nino 设备上 PIN 输错锁定"
- 家长可远程"强制解锁"或"等待自动解锁"

------

## 4. 设备所有权与角色切换

### 4.1 设备所有权三态

设备注册时必须明确归属类型：

| 类型             | 典型场景            | NinoGame 行为                                     |
| ---------------- | ------------------- | ------------------------------------------------- |
| `child_primary`  | Nino 的笔记本/手机  | 默认 Child Mode，监控全开                         |
| `parent_primary` | 你的工作笔记本/手机 | 默认 Parent Mode，零监控；除非主动切到 Child Mode |
| `shared`         | 客厅 PC / 家庭平板  | 默认 Lock 态，任何使用都要选身份                  |

**核心理念：NinoGame 跟着孩子走，不是装满全家所有设备。** 家长主用设备如果你不主动启用，根本不该有监控负担。

### 4.2 角色状态机

```
                ┌─────────┐
                │  Lock   │
                │（无人） │
                └────┬────┘
        Nino PIN ↗   │   ↘ 家长密码
                ↗    │    ↘
   ┌────────────┐    │    ┌────────────┐
   │ Child Mode │    │    │ Parent Mode│
   │            │←───┤    │            │
   │ 全监控     │ Lock 按钮│ 零监控     │
   │ Token 计费 │←───→    │ 操作自由   │
   └────────────┘         └────────────┘
         ↑                       ↑
         └── 闲置 10 分钟自动回 ─┘
            (仅 Child Mode)
```

### 4.3 关键设计点

| 设计点                      | 决策                           | 原因                 |
| --------------------------- | ------------------------------ | -------------------- |
| 孩子主用设备开机要 PIN？    | 否，开机自动进 Child Mode      | UX 优先              |
| 首次使用消耗类 App 要 PIN？ | 是                             | 验证放在"花钱"瞬间   |
| Parent Mode 自动回 Lock？   | **否**，家长自己 Lock          | 家长不需被技术限制   |
| Child Mode 闲置 Lock？      | 10 分钟无输入即 Lock           | 兼顾自动化与会话清晰 |
| 共享设备默认状态？          | Lock                           | 强制每次显式选身份   |
| Parent Mode 是否记录日志？  | 不监控、不浮层、不记录前台 App | 尊重家长隐私         |

### 4.4 会话边界

会话开始（计费起点）：

- Child Mode 激活的瞬间
- 写 `sessions` 表 + 通知 Backend

会话结束（计费终点）：

- Nino 点 Lock 按钮
- 闲置 10 分钟自动 Lock
- 切到 Parent Mode
- 设备关机/休眠
- 立即上报最后一段 partial usage，不等 5 分钟 tick

------

## 5. 成熟度档位（Maturity Mode）

成熟度档位是**全局单一配置**，定义系统的"控制温度"。

### 5.1 四档定义

| 档位             | 适用阶段 | 控制模式                          |
| ---------------- | -------- | --------------------------------- |
| `strict`         | 6-10 岁  | 家长决定，孩子只能申请            |
| `negotiable`     | 10-13 岁 | 可申请、可挣 token、规则透明      |
| `advisory`       | 13-16 岁 | 孩子主导，家长仅可见+提醒，软干预 |
| `self_regulated` | 16+      | 孩子自定规则，家长零干预          |

### 5.2 各档下功能差异

| 流程             | strict      | negotiable              | advisory     | self_regulated |
| ---------------- | ----------- | ----------------------- | ------------ | -------------- |
| 拦截动作         | kill + 警告 | kill + 警告             | 仅警告不杀   | 完全关闭       |
| 申请审批         | 无入口      | 核心场景                | 退化为"知会" | 不需要         |
| 任务验证         | 全验证      | 大任务验证 / 小任务自报 | 全自报       | 不需要         |
| 新游戏分类       | 严格        | 标准                    | 仅记录       | 关闭           |
| Dashboard 复杂度 | 简化版      | 完整版                  | 完整 + 报表  | 数据导出+API   |

### 5.3 切换机制

- 档位是家长在后台配置
- 切换会有提示："切换到 X 档位将把以下功能改为 Y。是否同时通知孩子？"
- 默认随孩子年龄推荐（注册时根据 birth_year 推荐起步档位）

------

## 6. 配额档位（Quota Package）

配额档位与成熟度档位**正交**——前者控制"量"，后者控制"控制方式"。

### 6.1 五档定义

| 档位             | 适用            | 工作日基础 | 周末基础 | 每日 token 上限 | 每日硬上限 | 高消耗费率 |
| ---------------- | --------------- | ---------- | -------- | --------------- | ---------- | ---------- |
| **严守**         | 6-9 / 严管家庭  | 0 token    | 60       | 60              | 1h         | 2x         |
| **平衡（默认）** | 10-13 / 大多数  | 30         | 90       | 120             | 2h         | 1.5x       |
| **任务驱动**     | 习惯培养 / ADHD | 15         | 45       | 180             | 2.5h       | 1.5x       |
| **信任**         | 13+ / 自律基础  | 60         | 120      | 240             | 3h         | 1x         |
| **自定义**       | 高级            | -          | -        | -               | -          | -          |

### 6.2 家长选择时看到的说明文案

**严守型：** "孩子的屏幕时间不是默认权利而是奖励。所有游戏时间都需要通过完成任务挣得。"

**平衡协商型（推荐）：** "孩子有一定的'默认娱乐权'，但可以通过努力换取更多。规则透明可协商。"

**任务驱动型：** "基础日额较少，但完成任务的回报很丰厚。适合用游戏时间作为正面强化、培养具体习惯。"

**信任放手型：** "孩子已建立自律基础，系统主要作用是提醒与数据可见，而非强制。"

### 6.3 关于档位

- **首次注册强制选档位**，不允许直接进自定义
- **档位是"模板"不是"锁"**：选后所有参数被填充，家长可单独再改
- **后台显示偏离度**："当前为'平衡协商型'，每日硬上限你调高了 60 分钟"

------

## 7. Token 经济模型

### 7.1 核心定位

**Token = 一份可自由支配的屏幕时间额度。**

不是"游戏币"——如果只限游戏，孩子会迁移到 B 站、短视频、社交。Token 的支出对象是**所有消耗类应用**的总和。

### 7.2 应用三类分类

| 类别            | 性质                           | Token 行为                   |
| --------------- | ------------------------------ | ---------------------------- |
| **consumption** | 游戏、视频、短视频、漫画、社交 | 前台时**扣 token**           |
| **neutral**     | 浏览器、即时通讯、笔记         | 不扣不赚                     |
| **productive**  | 学习、阅读、编程、健身         | 前台时**赚 token**（Path 1） |

分类由全局表 + 家长 override 决定（详见 §9 与 §18 数据模型）。

### 7.3 赚分规则

详见 §8 五条赚分路径。关键参数：

- **每日 token 获取上限：** 按档位（60 / 120 / 180 / 240）
- **任务单项上限：** 防止重复刷同任务（如阅读每日最多算 60 分钟）
- **周末加成：** 仅基础日额翻倍，不影响其他

### 7.4 消费规则（**决策 #33 已修订**：统一在线时长扣分）

```
child 模式 + 活跃 (最近 2 分钟有输入) → 每分钟扣 N token (不区分前台)
```

- 默认 `token_to_minute_ratio = 1.0`（1 分钟 = 1 token，settings.json 可调）
- **不再按 consumption / productive 区分前台**：任何被使用都按时长扣
- 每日硬上限：**默认 0 = 不限**（决策 #35）。家长若想"用满 N 分钟即停"才设非 0；否则扣到余额为 0 自然停。
- 余额耗尽：不再扣 + 不再 kill 进程（家长可远程 lock_device，孩子闲置 10min 也自动 lock）

> 原"应用费率系数"机制（CLAUDE.md v0.4 之前）已废止。`app_categories.rate_multiplier` 字段仍保留供历史审计 + 未来扩展，但不参与扣分决策。

### 7.5 不消费的特殊情况

- 被批准的 `unlock` 期内（消耗的是申请时预扣的 token）
- 限免活动期内（家长开启）
- 闲置期（>2 分钟无输入）
- Lock 模式 / Parent 模式（不计费）
- ~~学习类应用永不扣 / 教育类视频白名单~~ — 决策 #33 后不再按分类豁免

### 7.6 离线策略

**离线 = 禁消费**（已决策）。

- 已生效的 unlock 期内：可继续使用至时间到
- 没有 unlock 时离线：消耗类应用启动即拦截，提示"离线无法消费 token"
- 离线 >30 分钟：UI 显示"离线模式"
- 服务端检测离线 >10 分钟 → 推送家长

------

## 8. 赚分路径

按摩擦度由低到高排列。

### 8.1 ~~Path 1: 自动检测（零摩擦）~~ — 已下线（决策 #33）

**原计划**: 生产类应用前台 (Kindle/VSCode/Duolingo/Keep) 按时长自动写 +token ledger，每日按上限封顶。

**已下线**: 与扣分模型简化配套，自动挣分链路一并删除。理由：

- 维护"哪些 exe 算学习类"摩擦大，孩子主战场在网页 + 小程序，exe 分类抓不到
- 自动挣分 + 自动扣分两个反向系统并存，决策复杂，孩子也容易产生"我开 VSCode 就能赚 token"的对抗优化
- 简化后挣分只走 Path 2 (申报) / Path 3 (任务) / Path 5 (家长发奖) ——**都需要孩子主动表达 / 家长主动判断**，更符合"协商接口"哲学（§1.3）

`app_categories.productive` 标签仍保留在 schema 里（不删），将来若有更可靠的"学习识别"机制 (LLM / 时间窗口规则) 再启用。

### 8.2 Path 2: 一键申报（低摩擦）

| 事项       | 申报方式                       | 验证                                |
| ---------- | ------------------------------ | ----------------------------------- |
| 作业完成   | 一行文字描述                   | 私下沟通确认 → 家长后台 +token      |
| 户外运动   | 文字（"跑了 20 分钟"）         | 私下沟通确认 → 家长后台 +token      |
| 家务       | 文字（"洗了碗 / 拖了地"）      | 私下沟通确认 → 家长后台 +token      |
| 乐器练琴   | 文字（"练了 30 分钟 C 大调"）  | 家长听一段后 → 家长后台 +token      |
| 看了一本书 | 文字（"读了第几章 + 简短感想"）| 家长读后 → 家长后台 +token          |

> **拍照证据机制已下线**：原计划用 LLM Vision 给拍照初筛, 但 ① 增加孩子端操作摩擦 ② 隐私敏感 ③ 家长最终还是要看图判断, LLM 摘要价值有限。改为"孩子文字申报 + 家长私下口头/微信确认 + 家长后台手动 `+N token` 发放"。详见 §22 决策 #32。

### 8.3 Path 3: 计划任务（家长定义）

家长在后台创建任务模板，孩子在 UI 看见"今日可挣"清单：

```
今日任务（点击申报完成）：
□ 完成今日作业           +30 token
□ 练琴 30 分钟           +25 token
□ 阅读 30 分钟           +30 token
□ 整理书桌（责任类）     不挣分
□ 倒垃圾（责任类）       不挣分

本周特殊：
□ 周末大扫除一次         +50 token
□ 周记 500 字            +40 token
```

任务模板类型：

- 每日刷新
- 每周限次
- 一次性

### 8.4 Path 4: 区块/连续奖励（自动触发，P2）

服务端定时任务每日评估：

| 触发条件                  | 奖励                       |
| ------------------------- | -------------------------- |
| 连续 5 天完成所有日常任务 | +30 token 一次性           |
| 连续 7 天有阅读时长       | +50 token                  |
| 单周累计学习时长 ≥ 5 小时 | +40 token                  |
| 单月无未审批被拒申请      | +100 token + **信任值 +1** |

### 8.5 Path 5: 家长酌赠（手动）

家长任何时候在后台一键：

- "+30 / 表现不错"
- "+100 / 生日"
- "-20 / 因为今天 X 行为"（谨慎使用）
- 应急放行：直接给一个不扣 token 的 30 分钟 unlock

**无次数限制**（已决策），但后台 dashboard 温和显示统计："本月你已酌赠 23 次 / +480 token"。

### 8.6 责任类 Checklist（P1+ 引入，不挣分）

家长定义责任类任务，孩子每天勾选：

- 整理书桌
- 倒垃圾
- 自己叠被子
- 收拾餐桌

**不挣 token**，但每天给家长一份"今日责任 X/Y 完成"的报告。这条记录积累成"履责趋势"。

意图：分离"做人本分"与"突破基线的努力"——前者不该用积分系统稀释，但应该可见可追踪。

### 8.7 信任值（Trust Meter，P2 引入）

一个 0-5 的整数等级，由系统根据长期行为计算：

**升级条件（满足任一）：**

- 连续 4 周无未批准被拒申请 → +1
- 连续 30 天责任清单 ≥90% 完成率 → +1
- 完成阶段性大任务（如学期目标）→ 家长酌赠 +1

**降级条件：**

- 单月被拒申请率 >30% → -1
- 触发系统报警（如刷时间检测确认）→ -1

**信任值的意义（机制层面）：**

- Lv 1: 申请需家长完整审批
- Lv 2: 100 token 以下申请自动通过
- Lv 3: 标准时长（≤30 分钟）申请自动通过
- Lv 4: 触发自动从 negotiable 升级到 advisory 模式建议
- Lv 5: 系统自动建议进入 self_regulated 模式

**信任值的真实意义（教育层面）：** **这是系统"承载我开始信你了"的机制载体。** 比家长口头说"你长大了"更实际。

孩子端 Dashboard 显示当前信任值 + 距离下一级的差距，作为长期目标。

------

## 9. 规则引擎与检测系统

### 9.1 规则模型

```json
{
  "id": "rule_001",
  "child_id": "uuid",
  "name": "PvZ全家桶",
  "enabled": true,
  "matchers": [
    {"field": "process_name", "op": "icontains", "value": "pvz"},
    {"field": "process_name", "op": "icontains", "value": "plantsvszombies"},
    {"field": "window_title", "op": "icontains", "value": "植物大战僵尸"},
    {"field": "exe_path", "op": "icontains", "value": "PlantsVsZombies"}
  ],
  "matcher_logic": "OR",
  "exclude_processes": ["chrome.exe", "msedge.exe", "obs64.exe"],
  "schedule": {"mode": "always", "windows": []},
  "action": {
    "type": "kill_and_warn",
    "message": "不要想着玩不在我授权的游戏！"
  },
  "category_link": "consumption_game",
  "notify_parent": true
}
```

字段含义：

| 字段                | 类型     | 说明                                                         |
| ------------------- | -------- | ------------------------------------------------------------ |
| `matchers[].field`  | enum     | `process_name` / `exe_path` / `window_title` / `command_line` |
| `matchers[].op`     | enum     | `equals` / `iequals` / `contains` / `icontains` / `regex`    |
| `matcher_logic`     | enum     | `OR` / `AND`                                                 |
| `exclude_processes` | string[] | 进程名白名单                                                 |
| `schedule.mode`     | enum     | `always` / `windowed` / `disabled`                           |
| `action.type`       | enum     | `kill_and_warn` / `kill_silent` / `warn_only`                |

### 9.2 三层匹配（继承自 P0）

Agent 对每个进程做三维匹配：

1. **进程名** (`process_name`)
2. **可执行路径** (`exe_path`)
3. **窗口标题** (`window_title`)

任一匹配命中即触发规则。

### 9.3 LLM 后台分类器

**触发条件：** Agent 发现进程未命中本地缓存。

**流程：**

```
新进程出现 → 查 local_cache
   ↓未命中
默认放行 + 加入 unknown_queue
   ↓
每 5 分钟 Agent 批量上报 → Backend
   ↓
Backend 调 LLM 分类（批处理）
   ↓
LLM 输出 {category, sub_type, confidence, reasoning}
   ↓
Backend 写 app_categories + 推送家长"待审核"
   ↓
家长确认 → 规则更新推到 Agent
```

**为什么默认放行而不是默认拦截：** 避免误杀正常软件。代价是孩子能玩一次新游戏，收益是几乎不误伤工具软件。

### 9.4 本地缓存表

```
(process_name_hash, exe_path_hash) → {
  category: 'consumption' | 'neutral' | 'productive',
  sub_type: 'game' | 'video' | 'reading' | ...,
  rate_multiplier: 1.0,
  rule_ids: [...],
  classification_source: 'llm' | 'parent' | 'system',
  cached_at: timestamp,
  ttl_until: timestamp
}
```

TTL 7 天，过期重新分类。家长手动覆盖的不过期。

------

## 10. 会话与计费模型

### 10.1 会话生命周期

```
PC 启动 → Agent 启动
   ↓
默认 Lock（共享）或 自动 Child Mode（孩子主用）
   ↓
Nino PIN（共享设备）
   ↓
【SESSION START】
- 写 sessions: started_at = now
- WS 发 session_open
- 5min 上报循环启动
- 浮层、托盘激活
   ↓
... 使用 ...
   ↓
触发任一结束条件：
- 手动 Lock / 闲置 10min / 关机 / 切 Parent Mode
   ↓
【SESSION END】
- 上报最后 partial usage
- 写 sessions: ended_at, end_reason
- WS 发 session_close
```

### 10.2 计费规则核心（**决策 #33 + #36 修订**）

```python
# 每 60s 一次 tick
for each tick:
    if not child_mode:                       # Lock / Parent → 不计费
        skip(reason='mode_off')
    elif free_pass_active:                   # 限免活动中
        skip(reason='free_pass')
    elif daily_hard_cap_minutes > 0 and today_active >= cap:
        skip(reason='daily_cap'); notify_once()
    else:
        cost = tick_seconds / 60 * token_to_minute_ratio
        # 决策 #34: 推 token_tick 给 server, server 单一权威扣
        sent = send_token_tick({amount: cost, ...})
        if not sent:
            skip(reason='transport_offline')
```

**关键约束：**

- **不再按 consumption / productive 区分前台** — 任何前台都按时长扣 (决策 #33)
- **不再判定活跃** — child 模式在跑就扣, 不看键鼠输入 (决策 #36)
- 余额耗尽 / 硬上限 **不再 kill 进程**，仅弹通知 + emit STATUS
- 规则匹配（PvZ 等）的 `kill_and_warn` 不变：仍由 rule_engine 直接杀
- Path 1 自动挣分链路已删除（决策 #33）
- **扣分权威源**: server (决策 #34); Agent 推 token_tick → server 写 ledger + 推 wallet_update 回

### 10.3 用户活跃判定 (决策 #36 后简化)

| 场景                     | 判定标准                  | 频率         |
| ------------------------ | ------------------------- | ------------ |
| 闲置自动 Lock 的"非活跃" | 连续 10 分钟无输入        | 实时         |

> ~~"计费的活跃"~~ (最近 2 分钟有键鼠输入) 已下线 (决策 #36): child 模式在跑就扣, 闲置 10 分钟自动 Lock 兜底。
> ~~"赚分判定的严格活跃"~~ 已下线 (决策 #33: Path 1 取消)。
> 鼠标轨迹检测 (§16.1 ②) 仍保留但当前没有调用场景, 等未来恢复 Path 1 / 严格活跃判定时再启用。

差异：**赚分判定更严格**——纯鼠标移动（jiggler 典型行为）不算活跃，必须有键盘 / 滚轮 / 点击事件。

### 10.4 5 分钟上报包

```json
{
  "session_id": "sess_xxx",
  "child_id": "nino",
  "device_id": "pc_001",
  "period_start": "2026-05-12T16:30:00",
  "period_end": "2026-05-12T16:35:00",
  "foreground_segments": [
    {"app": "PlantsVsZombies.exe", "category": "consumption", "rate": 1.5, "active_seconds": 240, "idle_seconds": 0},
    {"app": "explorer.exe", "category": "neutral", "rate": 0, "active_seconds": 30},
    {"app": "(idle)", "active_seconds": 0, "idle_seconds": 30}
  ],
  "current_balance_local": 47,
  "rule_hits_in_period": []
}
```

Backend 收到后做权威结算（按服务端规则重算费率，写 ledger，推余额更新到所有设备）。

------

## 11. 跨端同步

### 11.1 支持平台

| 平台    | 支持     | 实现                              |
| ------- | -------- | --------------------------------- |
| Windows | ✅ P1     | Python Agent + Service            |
| Android | ✅ P3     | Kotlin App + AccessibilityService |
| iOS     | ❌        | Apple Screen Time 太封闭，跳过    |
| Mac     | ⏳ 未规划 | -                                 |

### 11.2 钱包权威源 = Backend

所有设备只持有"读缓存 + 待同步写入"，Backend 是唯一权威。

```
┌──────────┐                      ┌──────────┐
│ PC Agent │                      │ Android  │
│ cache:80 │                      │ cache:80 │
└────┬─────┘                      └────┬─────┘
     │ heartbeat (含本地消费) every 5min │
     └─────────────┬────────────────────┘
                   ↓
          ┌────────────────┐
          │   Backend      │
          │  wallet: 80    │
          │  ledger: [...] │
          └────────────────┘
```

### 11.3 离线策略（已决策：禁消费）

- 在线时所有 token 操作走 Backend
- 离线时消耗类应用启动 → Agent 直接拦截 + 提示"离线无法消费"
- 已生效的 unlock 期内可继续用（不需联网）
- 离线 >30 分钟孩子端显示"离线模式"
- 服务端检测 Agent 心跳 >10 分钟未到 → 推送家长

### 11.4 Unlock 跨端

家长批准的 unlock 作用范围：

- **按类别（不按设备）** —— "30 分钟 PvZ" = 所有设备上 PvZ 类应用都开闸
- **按墙上时间（不按累计使用）** —— 从批准时刻起 30 分钟内有效

应用费率消费仍按实际玩耍时间扣 token（unlock 是"放行许可"，token 是"使用成本"）。

### 11.5 跨端赚分聚合

Path 1 自动检测：同一类活动跨设备累加。

- PC 读 Kindle 30min + 手机读 30min = 60min 阅读
- 按每日上限封顶（如阅读 60min）只算一次

Backend 每 5min 处理上报包时做按 (child_id, app_category) 的聚合 + 上限判断。

------

## 12. LLM 集成

### 12.1 LLM 在系统里的三个位置

LLM 不直接拦截游戏（延迟和成本都不划算），而是在三个边界做翻译和初筛：

### 12.2 角色 1：翻译器（核心场景）

**输入：** 孩子的自然语言申请 + 上下文（今日已玩、token 余额、最近任务）

**输出：** 结构化 UnlockRequest

```python
def translate_request(text, context):
    # input: "我作业写完了想玩半小时PvZ"
    # output:
    return {
        "game": "rule_001",  # 匹配的规则
        "duration_minutes": 30,
        "cost_in_tokens": 0,  # 在基础时长内
        "claimed_completions": ["homework"],
        "needs_verification": True,
        "llm_summary": "孩子声称完成作业，申请30分钟。本周基础时长还剩100分钟。建议私下口头确认。",
        "confidence": 0.92
    }
```

家长端看到的是干净的结构化卡片 + 一行 LLM 总结 + 两个按钮（批准/拒绝）。如果不放心, 家长私下问孩子, 不走系统的"要照片"流程。

### 12.3 角色 2：后台分类器

详见 §9.3。批处理新进程，输出 category + sub_type + reasoning。

### 12.4 角色 3：~~验证助手（拍照初筛）~~ — 已下线

原计划: 家长要求 Nino 拍照证明 → Nino 上传 → LLM Vision 初筛。

**已删除**: 实际权衡后, 拍照机制 ① 增加孩子端操作摩擦 ② 隐私敏感 ③ 家长终究要看图判断, LLM 摘要价值有限。改为"孩子文字描述 + 家长私下确认 (口头/微信) + 家长后台手动 `+N token` 发放"。决策见 §22 #32。

### 12.5 LLM 服务的健壮性

- 故障时**软失败**：分类器失败 → 入队下次重试；翻译器失败 → 原文转发家长；验证失败 → 无 AI 摘要给家长直接看图
- LLM 是助手不是裁判：**永远不**让 LLM 直接代家长批准/拒绝

------

## 13. 协商与审批流程

### 13.1 申请-审批主流程

```
Nino 点托盘 NinoGame 图标 → 本地 web UI
   ↓
看到余额、今日活动、可选任务
   ↓
点"申请游戏时间" → 输入自然语言
   ↓
Agent → Backend → LLM 翻译
   ↓
推送家长（企业微信） → 结构化卡片
   ↓
家长点：批准 / 拒绝
（不放心? → 私下问孩子, 不走系统）
   ↓
批准 → WS 推 command: temporary_unlock
   ↓
Agent 应用：rule 标记 unlocked until T+30min
   ↓
Nino 端 UI 显示倒计时 + 托盘 badge
   ↓
T+25min: 弹"还有 5 分钟"
   ↓
T+30min: unlock 过期，正常规则恢复
```

### 13.2 防申请轰炸

- 每日最多 3 次申请
- 两次申请间至少 1 小时
- 家长 30 分钟未响应 → 申请超时 + Nino 端"未及时回复"
- 超时的请求不消耗申请配额

### 13.3 任务完成审批

类似流程：

```
Nino 申报任务完成 (文字描述, 不传图)
   ↓
推送家长 → 简洁卡片 (任务名 + 申报备注)
   ↓
家长私下确认 (口头/微信) — 不放心可以直接问孩子
   ↓
批准 → 写 ledger + 上限检查
拒绝 → 通知 Nino + 可选评论
```

### 13.4 LLM 协商温度

任你后续配置（待决策，§22 #29），默认：

- 申请翻译：冷静专业（"申请：30 分钟，理由：作业完成"）
- 验证摘要：客观描述（"图片显示数学作业三页，看起来完成"）

不带情感修饰，避免操纵家长决策。

------

## 14. 家长后台

### 14.1 技术栈

Vite + React + TailwindCSS + shadcn/ui，移动端响应式。

### 14.2 核心页面

| 页面       | 主要功能                                 |
| ---------- | ---------------------------------------- |
| 登录       | username/password + 可选记住设备         |
| 设备列表   | 卡片式，在线状态、今日活动概览           |
| 规则编辑   | 列表 + 详情抽屉（启用/匹配器/调度/动作） |
| 任务管理   | 模板 CRUD + 完成记录                     |
| 实时事件流 | WebSocket 订阅，新事件浮现               |
| 调账记录   | 历史 + 申诉表单                          |
| 限免活动   | 启用/管理面板                            |
| 数据报表   | 周/月/年趋势                             |
| 设置       | 档位、推送、配额、子账号管理             |

### 14.3 设备卡片快速操作

```
┌─────────────────────────────────┐
│ 📱 Nino 的手机   🟢 在线        │
│ 今日: 玩 45min / 学 30min       │
│ 余额: 47 token                  │
│                                 │
│ [限免 1h] [全锁] [发消息] [详情]│
└─────────────────────────────────┘
```

### 14.4 限免活动

详见 §1.3 决策。家长一键启用，孩子端醒目显示"🎁 限免中"。

### 14.5 调账

- 调账记录孩子可见（§22 #27）
- 例："妈妈帮我退了 30 分钟，因为那段时间我在学校"
- 每笔调账必须填理由（不能无声调账）

------

## 15. 孩子端可视化与自我管理

这是系统真正"教"的部分。详细 UX 设计见前面讨论。

### 15.1 三个时间尺度的感知

| 尺度     | 形式                      | 位置               |
| -------- | ------------------------- | ------------------ |
| **此刻** | 系统托盘 badge + 可选浮层 | 永远可见           |
| **今天** | Dashboard 主页            | 点击托盘进入       |
| **未来** | Forecast 模块             | Dashboard 默认显示 |

### 15.2 系统托盘 / 状态栏图标

| 图标     | 含义                            |
| -------- | ------------------------------- |
| 🔒 灰色   | Lock 态，无人计费               |
| 👦 + 💎 47 | Nino 使用中，余额 47            |
| 👦 + 💤    | Nino 已登录但闲置               |
| 👨        | Parent Mode（家长私域，不计费） |
| 🎁 + 时间 | 限免活动中                      |

### 15.3 玩游戏时浮层（默认开，可关）

```
┌──────────────┐
│ 💎 47        │
│ ⏱ 28 min剩  │
└──────────────┘
```

- 数字每分钟真实下降 1（或按费率）
- 颜色随余额：绿→黄→橙→红
- **不弹窗、不发声**，安静变色
- 95% 时短暂闪烁 + 一行"5 分钟后将自动结束"

### 15.4 Dashboard 设计

```
你好 Nino · 周三 下午 4:30
─────────────────────────
💎 80 tokens
≈ 玩 PvZ 53 分钟 / 看 B站 53 分钟 / 攒到周末

[████████░░] 80/100 今日额度

今天的轨迹：
挣: +30 (基础) +20 (阅读) = 50
花: -15 (PvZ 早上) = 15

今天还能做的事：
□ 完成作业        +30
□ 练琴 30 分钟    +25
□ 阅读再 30 分钟  +20
□ 整理书桌（责任）不挣分

[申请玩游戏...]

这周：
本周总进账: ▁▂▃▆▅▂▃
本周净结余: +23
连续 3 天完成任务（再 2 天 +50！）
信任值: ★★☆☆☆ (Lv 2)
```

### 15.5 Forecast（默认显示）

```
按当前速度：
- 18:00 用完今天剩余
- 19:30 触及每日 token 余额

如果现在停下：
- 还剩 47 token 留到明天
- 明天可以玩 ≈40 分钟
```

**两个未来并排显示**——继续 vs 停下的对比，让选择变成可视化。

### 15.6 自我反思机制

**会话后微反思（已决策：每天前 2 次必问 + 之后 20% 抽样）：**

```
玩了 35 分钟 PvZ，花了 35 token
现在感觉？
😊 值了    😐 一般    😞 不太值
```

**每周回顾（周日晚）：**

```
本周回顾
─────
赚得最多: 周二 (+85)
花得最多: 周六 (-90)
最满足: 周日下午 PvZ 45min 😊
最不满足: 周三晚短视频 30min 😞
净结余: +12

下周想试什么？
○ 攒 200 用周末长玩
○ 试试 5 连任务的 +50 奖励
```

### 15.7 数据隐私边界（已决策）

- **反思数据（满意度评分、情感标签）：孩子私有**
- **趋势数据（时长、token 流水）：家长可见**

让反思是"安全的自省"，不变成"被审判的素材"。

### 15.8 UI 随档位升级

| 档位             | UI 复杂度                        |
| ---------------- | -------------------------------- |
| `strict`         | 大余额 + 简单进度条 + 今日可做事 |
| `negotiable`     | 完整 Dashboard                   |
| `advisory`       | 完整 + 月度报表 + 自定义目标     |
| `self_regulated` | 数据报表 + API + 可导出          |

升级本身就是奖励。

### 15.9 失败的处理哲学（已决策：option C）

如果 Nino 周二把一周额度全花完了，系统**不主动救济**。让他自己面对周三-周日的窘迫。要的是真实的反馈循环，不是无后果的玩耍。

家长仍可酌情用 Path 5 救济，但默认不动。

------

## 16. 防滥用机制

### 16.1 防刷"赚分时间"（Path 1）

**多层防御：**

**① 严格活跃判定（赚分场景）：** 60s 内必须有 key/scroll/click 事件，鼠标位移不算。

**② 鼠标轨迹特征检测：**

- 采样 60s 鼠标轨迹
- 计算位移方差、时间间隔方差
- 低于阈值（机械感）→ 当前周期不计赚分 + 推家长 alert

**③ 应用特定信号：**

- Kindle PC 版：窗口标题含页码，标题不变 = 没翻页
- 累计 5min 无变化 → 不计赚分
- 视频、学习 App 类似

**④ 行为基线异常告警：**

- 服务端为每孩子建基线
- 偏离 2x 触发审核（"周三阅读 95min 平时均值 35min"）
- 不阻止，但推送家长"待核查"

**⑤ 每日上限兜底：** 即便上述全被绕过，每类活动每日上限封顶。

### 16.2 防 jiggler / 假活跃（防 Lock）

孩子可能用鼠标抖动器避免 10 分钟闲置 Lock。

防御：§16.1 ① 和 ② 同样适用——即便鼠标在动，机械动会被判为闲置，照样 Lock。

### 16.3 PIN 暴力尝试

3 次错误锁 30 分钟 + 推送家长。

### 16.4 实现优先级

| 防御            | 优先级 | 成本              |
| --------------- | ------ | ----------------- |
| ① 严格活跃判定  | P1     | 低                |
| ⑤ 单类/单日上限 | P1     | 已设计            |
| ② 鼠标轨迹检测  | P2     | 中                |
| ③ 应用特定信号  | P3     | 高（逐 App 适配） |
| ④ 异常告警      | P2     | 中                |
| 抽样验证        | P3+    | 中（侵入式）      |

------

## 17. 自保护

### 17.1 层级

1. **进程级互守：** Agent ↔ Watchdog 互相监视
2. **服务级注册：** Windows Service，普通用户停不掉
3. **卸载需密码：** 本地 hash + 云端 hash 双重
4. **远程激活：** 家长可远程下发 `lock_device`，立即激活全部规则

### 17.2 故意不做的事

- ❌ 不注入 explorer.exe / svchost.exe
- ❌ 不修改 Windows 防火墙、不挂内核
- ❌ 不隐藏自身进程
- ❌ 不阻止用户查看本程序日志和规则
- ❌ 不在 Android 上请求 Device Admin（除非必要）

### 17.3 诚实评估绕过可能

真技术党孩子绕过手段：重装系统、PE 启动盘删 Service、虚拟机里运行游戏、用未注册设备……都能绕过。

**这是家长控制系统不是反渗透测试**。最终防线是家庭沟通，不是技术。

------

## 17.5 Agent 实施架构（P1 为 P2 做准备）

### 17.5.1 P1 范围最小化

为加速 P2，P1 聚焦核心闭环，把"需要后端才完整"的功能整体推后到 P2：

**P1 留下：**

- 核心监控模块化拆分
- 本地 SQLite Store
- Watchdog + Service 注册
- PyInstaller 打包
- 本地 Token 经济（基础日额 / 消费扣分 / 自动检测赚分）
- 责任 checklist（本地 JSON 配置）
- 托盘图标（最简版，显示余额）
- 防刷 ① 严格活跃判定 + ⑤ 单日上限

**移到 P2（与后端一起做）：**

- 完整孩子 Dashboard Web UI
- 申请-审批流程
- LLM 集成
- 跨端同步
- Forecast / 反思机制

### 17.5.2 设计原则：接口先行

P1 完全本地运行，但所有数据访问、消息传递、配置加载都走接口抽象，P2 只换实现不改业务逻辑。

四个关键接口决定 P2 接入工作量：

| 接口             | P1 实现               | P2 实现                         |
| ---------------- | --------------------- | ------------------------------- |
| `RuleRepository` | 本地 JSON 读写        | 本地缓存 + 订阅 rules_update    |
| `WalletService`  | 本地 SQLite 算账      | 写穿透后端 + 接收 wallet_update |
| `EventSink`      | 写本地 SQLite events  | 写本地 + Transport 上报         |
| `Transport`      | NullTransport (no-op) | WebSocketTransport              |

**业务模块（core/）只依赖接口，永不直接操作存储或网络**。这是 P1→P2 平滑过渡的核心保障。

### 17.5.3 目录结构

```
NinoGame-agent/
├── core/
│   ├── monitor.py              # 进程扫描+窗口枚举 → ProcessSnapshot
│   ├── rule_engine.py          # ProcessSnapshot + Rules → MatchResults
│   ├── killer.py               # MatchResult → kill + 弹窗 + 发事件
│   ├── activity_detector.py    # 活跃判定（消费 2min / 赚分 60s 双标准）
│   ├── session_manager.py      # 会话生命周期
│   ├── token_engine.py         # token 扣/赚/查询
│   ├── checklist.py            # 责任清单
│   └── classifier.py           # 应用分类查询（本地缓存优先）
│
├── store/
│   ├── repository.py           # 接口定义（ABC）
│   ├── local_sqlite.py         # P1 实现：SQLite 全部
│   ├── schema.sql              # 本地建表脚本
│   └── seed_data.py            # 初始数据（PvZ 规则、App 分类种子）
│
├── comms/
│   ├── transport.py            # Transport 接口
│   ├── null_transport.py       # P1 实现：no-op
│   ├── event_bus.py            # 进程内事件总线
│   └── message_types.py        # 所有消息 dataclass
│
├── protector/
│   ├── watchdog.py             # 独立守护进程
│   ├── self_protector.py       # 互守逻辑
│   └── pin_manager.py          # PIN 校验
│
├── ui/
│   ├── tray_icon.py            # 系统托盘（pystray）
│   └── notifier.py             # 警告弹窗
│
├── config/                     # 用户可编辑配置（PyInstaller 不打包）
│   ├── rules.json              # 规则集（首版含 PvZ 全变种）
│   ├── app_categories.json     # App 分类（种子，可被分类器更新）
│   ├── tasks.json              # 任务模板（含责任 checklist）
│   ├── settings.json           # maturity/package/PIN_hash 等
│   └── child_profile.json      # username, birth_year 等
│
├── data/                       # 运行时数据（不在仓库）
│   ├── NinoGame.db             # SQLite
│   └── logs/                   # 滚动日志
│
├── main.py                     # 主进程入口
├── watchdog_main.py            # Watchdog 入口
├── requirements.txt
└── pyinstaller_build.bat
```

### 17.5.4 关键接口契约

```python
# store/repository.py
from abc import ABC, abstractmethod
from typing import Optional, Callable
from comms.message_types import Rule, AppCategory, Event

class RuleRepository(ABC):
    """P1: 本地 JSON 读写
       P2: 本地缓存 + 订阅 rules_update"""
    @abstractmethod
    def get_all(self) -> list[Rule]: ...
    @abstractmethod
    def save(self, rule: Rule) -> None: ...
    @abstractmethod
    def subscribe_changes(self, callback: Callable) -> None: ...


class WalletService(ABC):
    """P1: 本地 SQLite 算账
       P2: 写穿透后端 + 接收 wallet_update"""
    @abstractmethod
    def get_balance(self) -> int: ...
    @abstractmethod
    def deduct(self, amount: int, reason: str, ref_id: str = None) -> bool: ...
    @abstractmethod
    def credit(self, amount: int, reason: str, ref_id: str = None) -> None: ...
    @abstractmethod
    def get_daily_consumed(self) -> int: ...


class EventSink(ABC):
    """P1: 写本地 SQLite events
       P2: 写本地 + Transport 上报"""
    @abstractmethod
    def emit(self, event: Event) -> None: ...


# comms/transport.py
class Transport(ABC):
    """P1: NullTransport（do-nothing）
       P2: WebSocketTransport"""
    @abstractmethod
    def send(self, message: dict) -> None: ...
    @abstractmethod
    def subscribe(self, message_type: str, handler: Callable) -> None: ...
    @abstractmethod
    def is_connected(self) -> bool: ...
```

业务模块示例（P1→P2 时**零改动**）：

```python
# core/killer.py
class Killer:
    def __init__(self, event_sink: EventSink, notifier: Notifier):
        self.events = event_sink
        self.notifier = notifier

    def kill_and_warn(self, match: MatchResult):
        # ... kill 进程逻辑
        self.events.emit(Event(
            type='block',
            payload={'rule_id': match.rule.id, 'process': match.process.name}
        ))
        self.notifier.warn_async(match.rule.action.message)
```

P1 注入 `LocalEventSink`，P2 替换为 `BackendEventSink`（同时写本地和上报）。Killer 代码不动。

### 17.5.5 本地 SQLite Schema

Agent 端本地存储（与 §18 的 Backend PostgreSQL schema 是不同的）：

```sql
-- 本地钱包（P2 时此表作为缓存，权威值在后端）
CREATE TABLE wallet (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行表
  balance INTEGER NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMP,
  last_daily_grant_date DATE
);

-- 账本（不可变）
CREATE TABLE token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_id TEXT,
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server BOOLEAN DEFAULT 0
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  end_reason TEXT,
  total_active_seconds INTEGER DEFAULT 0,
  total_tokens_consumed INTEGER DEFAULT 0,
  synced_to_server BOOLEAN DEFAULT 0
);

CREATE TABLE app_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  app_identifier TEXT,
  category TEXT,
  rate_multiplier REAL,
  active_seconds INTEGER,
  idle_seconds INTEGER,
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  tokens_consumed INTEGER DEFAULT 0,
  synced_to_server BOOLEAN DEFAULT 0
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT,                          -- JSON
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server BOOLEAN DEFAULT 0
);

CREATE TABLE app_categories (
  app_identifier TEXT PRIMARY KEY,
  category TEXT,                         -- consumption / neutral / productive
  sub_type TEXT,
  rate_multiplier REAL DEFAULT 1.0,
  source TEXT,                           -- seed / user / llm
  updated_at TIMESTAMP
);

CREATE TABLE responsibility_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  check_date DATE,
  completed BOOLEAN,
  checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server BOOLEAN DEFAULT 0
);

CREATE TABLE task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  status TEXT DEFAULT 'pending',
  evidence_path TEXT,
  child_note TEXT,
  reward_granted INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server BOOLEAN DEFAULT 0
);

CREATE TABLE unknown_apps_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_identifier TEXT,
  exe_path TEXT,
  window_title TEXT,
  first_seen_at TIMESTAMP,
  processed BOOLEAN DEFAULT 0
);

CREATE INDEX idx_ledger_synced ON token_ledger(synced_to_server, occurred_at);
CREATE INDEX idx_events_synced ON events(synced_to_server, occurred_at);
CREATE INDEX idx_segments_synced ON app_segments(synced_to_server, period_start);
```

**核心设计：** 几乎每张表都有 `synced_to_server` 字段。P1 永远写 0，P2 上线后老数据可批量回传补上。这是 P1→P2 平滑过渡的核心。

### 17.5.6 P1 推进顺序

```
Step 1: store/* + schema           → 数据层先稳
Step 2: comms/message_types + bus  → 消息契约
Step 3: core/monitor               → 改造 pvz_monitor.py
Step 4: core/rule_engine + killer  → 拦截链路跑通
Step 5: core/activity_detector     → 防刷基础
Step 6: core/session_manager + token_engine  → token 闭环
Step 7: ui/tray_icon + notifier    → 用户可见
Step 8: protector/*                → 自保护
Step 9: main.py + PyInstaller + NSSM
```

Step 1-4 完成即有"能拦截 + 能记录"的最小可用版本，可先验证打包链路再继续。

------

## 18. 数据模型

### 18.1 核心表

```sql
-- 家长账号
CREATE TABLE parents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  push_config JSONB,  -- 企业微信 webhook 等
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 孩子账号
CREATE TABLE children (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES parents(id),
  username VARCHAR(32) UNIQUE NOT NULL,
  display_name VARCHAR(64),
  birth_year INT,
  pin_hash VARCHAR(255),
  maturity_mode VARCHAR(16),    -- strict / negotiable / advisory / self_regulated
  quota_package VARCHAR(16),    -- tight / balanced / task_driven / trust / custom
  quota_overrides JSONB,        -- 档位之外的单项 override
  trust_level INT DEFAULT 1,    -- 信任值 0-5
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 设备
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type VARCHAR(16),       -- child_primary / parent_primary / shared
  default_mode VARCHAR(16),      -- auto_child / auto_parent / locked
  idle_lock_minutes INT DEFAULT 10,
  name VARCHAR(128),
  pairing_code VARCHAR(16),
  agent_token VARCHAR(64) UNIQUE,
  os_info JSONB,
  platform VARCHAR(16),          -- windows / android
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 设备绑定（孩子-设备多对多但通常一对一）
CREATE TABLE device_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES devices(id),
  child_id UUID REFERENCES children(id),
  bound_at TIMESTAMPTZ,
  unbound_at TIMESTAMPTZ,
  is_shared BOOLEAN DEFAULT FALSE
);

-- 会话
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  child_id UUID,
  mode VARCHAR(16),              -- child / parent / limited_free
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason VARCHAR(32),        -- manual_lock / idle / shutdown / switched
  total_active_seconds INT,
  total_tokens_consumed INT
);

-- 钱包
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID REFERENCES children(id) UNIQUE,
  balance INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ
);

-- 账本（所有 token 变动的不可变记录）
CREATE TABLE token_ledger (
  id BIGSERIAL PRIMARY KEY,
  wallet_id UUID,
  delta INT NOT NULL,
  balance_after INT NOT NULL,
  reason VARCHAR(32),
  -- daily_grant / task_reward / path1_auto / app_consumption /
  -- unlock_prepay / refund / parent_grant / streak_bonus / adjustment
  ref_id UUID,
  device_id UUID,
  occurred_at TIMESTAMPTZ
);

-- 规则
CREATE TABLE rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID REFERENCES children(id),
  name VARCHAR(128),
  enabled BOOLEAN DEFAULT TRUE,
  spec JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 应用分类
CREATE TABLE app_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_identifier VARCHAR(255),
  category VARCHAR(16),          -- consumption / neutral / productive
  sub_type VARCHAR(32),
  rate_multiplier DECIMAL(3,2) DEFAULT 1.0,
  classification_source VARCHAR(16),  -- llm / parent / system
  child_id UUID,                 -- 空=全局规则，非空=个人 override
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 任务模板
CREATE TABLE task_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID,
  name VARCHAR(128),
  category VARCHAR(32),          -- responsibility（不挣 token）/ incentive
  reward_tokens INT,
  daily_max_completions INT,
  verification VARCHAR(16),      -- parent_approve / self_report / auto (photo 已下线, 仅兼容)
  schedule VARCHAR(16),          -- daily / weekly / once
  active BOOLEAN DEFAULT TRUE
);

-- 任务完成
CREATE TABLE task_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID,
  child_id UUID,
  status VARCHAR(16),
  photo_url TEXT,                -- 已弃用 (拍照机制下线); 保留列容纳老记录, 新申报不写入
  child_note TEXT,
  llm_summary TEXT,
  parent_decision_at TIMESTAMPTZ,
  parent_comment TEXT,
  reward_granted INT,
  created_at TIMESTAMPTZ
);

-- 责任清单完成（P1+, 无 token）
CREATE TABLE responsibility_checks (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID,
  child_id UUID,
  check_date DATE,
  completed BOOLEAN,
  checked_at TIMESTAMPTZ
);

-- App 使用会话
CREATE TABLE app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID,
  device_id UUID,
  app_identifier VARCHAR(255),
  category VARCHAR(16),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  active_seconds INT,
  tokens_consumed INT,
  unlock_id UUID
);

-- Unlock 记录
CREATE TABLE unlocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID,
  rule_id UUID,
  granted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  prepaid_tokens INT,
  consumed_tokens INT DEFAULT 0,
  refunded_tokens INT DEFAULT 0,
  source VARCHAR(16),            -- parent_approval / parent_grant / streak_auto
  request_id UUID
);

-- 限免活动
CREATE TABLE free_pass_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID,
  device_id UUID,                -- 空=所有设备
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  expected_duration_minutes INT,
  reason TEXT,
  ended_by VARCHAR(16),          -- timeout / parent_manual
  created_by_parent UUID
);

-- 申请
CREATE TABLE unlock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID,
  request_text TEXT,
  structured_request JSONB,      -- LLM 翻译后
  llm_summary TEXT,
  status VARCHAR(16),            -- pending / approved / rejected / expired / timeout
  parent_decision_at TIMESTAMPTZ,
  parent_comment TEXT,
  created_at TIMESTAMPTZ
);

-- 调账
CREATE TABLE billing_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID,
  parent_id UUID,
  original_consumed INT,
  adjusted_consumed INT,
  delta_tokens INT,
  reason TEXT,
  visible_to_child BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ
);

-- 事件（审计日志）
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  child_id UUID,
  device_id UUID,
  event_type VARCHAR(32),
  -- block / heartbeat / status / unlock_granted /
  -- session_open / session_close / pin_fail / jiggler_alert / ...
  payload JSONB,
  occurred_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ DEFAULT NOW()
);

-- 反思（孩子私有）
CREATE TABLE session_reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID,
  child_id UUID,
  app_identifier VARCHAR(255),
  satisfaction VARCHAR(8),       -- happy / neutral / regret
  visible_to_parent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ
);

-- 命令队列
CREATE TABLE commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  command_type VARCHAR(32),
  payload JSONB,
  status VARCHAR(16) DEFAULT 'pending',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 信任值变动（P2）
CREATE TABLE trust_changes (
  id BIGSERIAL PRIMARY KEY,
  child_id UUID,
  delta INT,
  new_level INT,
  reason VARCHAR(64),
  triggered_at TIMESTAMPTZ
);
```

### 18.2 关键索引

```sql
CREATE INDEX ON events (child_id, occurred_at DESC);
CREATE INDEX ON token_ledger (wallet_id, occurred_at DESC);
CREATE INDEX ON app_sessions (child_id, started_at DESC);
CREATE INDEX ON unlock_requests (child_id, status, created_at DESC);
```

------

## 19. 通信协议

### 19.1 连接生命周期

```
Agent 启动 → 读 agent_token
   ↓ 无 token → 进入配对模式（输配对码）
建立 wss://NinoGame.{domain}/ws/agent
   ↓ 发 hello {token, device_info, agent_version}
收到 hello_ack {rules, app_categories, pending_commands, wallet_balance}
   ↓
进入工作循环：
- 每 30s heartbeat
- 每 5min usage_report
- 检测到 block 立刻 event
- 收到 command 立刻处理 + command_ack
   ↓
连接断开 → 指数退避重连（1s/2s/4s/.../60s）
```

### 19.2 消息格式

```json
{
  "type": "string",
  "id": "uuid",
  "ts": "ISO8601",
  "payload": {}
}
```

### 19.3 Agent → Server

| type                             | 说明                                   |
| -------------------------------- | -------------------------------------- |
| `hello`                          | 鉴权握手                               |
| `heartbeat`                      | 心跳，含 last_active_status            |
| `event`                          | 拦截、PIN 失败、jiggler 检测等审计事件 |
| `usage_report`                   | 5 分钟使用上报包（见 §10.4）           |
| `unlock_request`                 | 孩子发起的申请（含原文 + 上下文）      |
| `task_claim`                     | 任务完成申报                           |
| `command_ack`                    | 命令执行回执                           |
| `session_open` / `session_close` | 会话边界                               |
| `unknown_apps`                   | 未知应用上报，求分类                   |

### 19.4 Server → Agent

| type                    | 说明                         |
| ----------------------- | ---------------------------- |
| `hello_ack`             | 握手+全量状态同步            |
| `command`               | 实时命令                     |
| `rules_update`          | 规则变更                     |
| `app_categories_update` | 应用分类表更新               |
| `wallet_update`         | 余额变更（其他设备消费触发） |
| `ping`                  | 主动探活                     |

### 19.5 Command 类型

| type               | payload                                      | 说明                    |
| ------------------ | -------------------------------------------- | ----------------------- |
| `temporary_unlock` | `{rule_id, duration_seconds, prepay_tokens}` | 临时放行                |
| `lock_device`      | `{}`                                         | 立即激活全部规则        |
| `start_free_pass`  | `{duration_minutes, reason}`                 | 开启限免                |
| `end_free_pass`    | `{}`                                         | 终止限免                |
| `request_status`   | `{}`                                         | 要求 Agent 上报当前状态 |
| `update_self`      | `{version, url}`                             | 自升级（P3）            |

------

## 20. 构建与部署

### 20.1 Agent 打包（Windows）

```bash
pip install psutil pywin32 websockets sqlalchemy aiohttp pillow

pyinstaller --noconsole --onefile \
    --name NinoGameAgent \
    --icon icon.ico \
    main.py
```

### 20.2 服务注册（NSSM）

```bat
nssm install NinoGameMonitorSvc "C:\Program Files\NinoGame\NinoGameAgent.exe"
nssm set NinoGameMonitorSvc Start SERVICE_AUTO_START
nssm set NinoGameMonitorSvc AppRestartDelay 5000
nssm start NinoGameMonitorSvc

REM Watchdog 同理
nssm install NinoGameWatchdogSvc "C:\Program Files\NinoGame\Watchdog.exe"
```

### 20.3 Backend 部署（1Panel）

部署在与 三个管家 同一服务器，**通过 1Panel 管理，不独占 80/443 端口**。

**步骤：**

1. **运行 Backend 服务（内部端口）**

   后端 Node 进程监听内部端口 `127.0.0.1:8088`（仅本机可达，外网不直接访问）。

   推荐方式：在 1Panel "应用商店"安装 Node.js 运行时，或用 PM2 在 1Panel "运行环境"里启动：

   ```bash
   pm2 start ecosystem.config.js --only NinoGame-backend
   ```

   `ecosystem.config.js` 关键配置：

   ```js
   {
     name: 'NinoGame-backend',
     script: './dist/index.js',
     env: {
       NODE_ENV: 'production',
       PORT: 8088,
       HOST: '127.0.0.1'   // 关键：只绑定本机，不暴露公网
     }
   }
   ```

2. **1Panel 创建网站 + 反代**

   1Panel 后台 → "网站" → "创建网站" → 选"反向代理"类型：

   - 域名：`NinoGame.{现域名}`
   - 代理 URL：`http://127.0.0.1:8088`
   - 启用 WebSocket 代理（**重要**，否则 Agent 长连接挂掉）

   建好后 1Panel 自动生成 OpenResty 配置，类似：

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8088;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_read_timeout 86400s;  # 长连接保持
   }
   ```

3. **配置 SSL**

   1Panel 后台 → 该网站 → "HTTPS" → "申请 Let's Encrypt 证书"（acme.sh 自动续期）。 配好后 wss://NinoGame.{现域名}/ws/agent 即可用。

4. **防火墙**

   服务器只需开放：80/443（1Panel 已占用）+ SSH 端口。后端 8088 不需要对外暴露。

5. **日志**

   - Backend 进程日志：PM2 / 1Panel 进程管理面板
   - 反代访问日志：1Panel 网站详情 → "日志"

### 20.4 Android（P3）

- Kotlin + Android Studio
- AccessibilityService 监前台 App
- Foreground Service 防系统杀
- 国内 ROM 适配清单（MIUI/华为/OPPO 后台权限）

### 20.5 NSIS 安装程序（P2）

- 拷贝 Agent.exe + Watchdog.exe 到 `Program Files\NinoGame\`
- 注册两个 Service
- 弹配对码输入框，首次绑定孩子账号
- 卸载程序要求家长密码

------

## 21. 阶段路线图

### P0 ✅ 完成

- [x] 本地脚本 `pvz_monitor.py`，关键词监控 PvZ 全变种
- [x] 三层匹配：进程名 / 路径 / 窗口标题
- [x] 异步弹窗

### P1 ✅ 模块骨架完成（目标 1-2 周）

- [x] 重构 `pvz_monitor.py` 为模块化（monitor / rule_engine / killer / store）
- [x] Rule 数据类 + 本地 JSON 配置
- [x] 本地 SQLite 审计日志
- [x] Watchdog.exe（Python 版本）
- [x] PyInstaller 打包脚本
- [x] NSSM 服务注册脚本
- [x] Token 经济本地版（无后端，本地配置）
- [x] 责任类 checklist（本地）
- [x] 严格活跃判定（防刷 ①）
- [x] 单日 token 上限兜底（防刷 ⑤）

**验收：** 双击安装包完成部署；重启服务自启；任务管理器看得见杀不掉；本地配置改一行加新游戏；Token 本地能扣能加。

### P2 — 远程控制 MVP（目标 3-4 周）

- [x] PostgreSQL schema `NinoGame` 建表
- [x] Node Backend：parents/children CRUD + 登录 + 设备配对 + WebSocket
- [x] Agent 接入 WebSocket，规则/分类/钱包从云端
- [x] React 控制台：登录 / 设备列表 / 规则编辑 / 任务管理 / 事件流
- [x] 一次性配对码流程
- [x] 申请-审批流程（不含 LLM）
- [x] 5 分钟使用上报 + 服务端聚合
- [x] 调账功能
- [x] 限免活动
- [x] 移动端响应式
- [x] 鼠标轨迹检测（防刷 ②）
- [x] 行为基线异常告警（防刷 ④）
- [x] **信任值机制**（P2 引入）

**验收：** 家长用手机改规则，5s 内孩子电脑生效；Nino 启动 PvZ，家长手机能在事件流看到；Agent 断网 10min 重连后历史事件全补。

### P3 — LLM 与跨端（目标 6-8 周）

- [x] LLM Service 接入 (多平台: OpenAI / DeepSeek / Qwen / Moonshot / 智谱 / Anthropic / 自定义; 家长后台 /llm-config 配置)
- [x] LLM 翻译器 (申请结构化: Agent 申请 → server 异步翻译 → 浏览器实时刷新 AI 摘要 + structured_request)
- [ ] LLM 后台分类器（unknown apps）
- [x] ~~LLM 验证助手（照片初筛）~~ — 已下线 (改私下协商 + 家长后台 +token, 见 §22 #32)
- [x] 时间窗口规则（schedule.windows）
- [x] ~~临时解锁命令~~ — 已实现 (P2)
- [ ] 企业微信机器人推送
- [x] 使用时长统计/报表 (家长后台 /reports 页: 14 天柱状图 + Top 应用)
- [ ] **Android NinoGame App**
- [ ] 跨端钱包同步 + Path 1 跨端聚合

**验收：** Nino 自然语言申请 → 家长收结构化卡片；新游戏自动分类待审；PC + Android 钱包余额一致；Android Kindle 阅读自动赚分跨端聚合。

### P4 — 进阶（目标 3-6 月内）

- [ ] 多孩子 UI
- [ ] Agent 自升级
- [ ] 卸载密码保护流程
- [ ] 应用特定信号检测（防刷 ③）
- [ ] 自动 maturity_mode 升级建议
- [ ] 数据导出（CSV / JSON）
- [ ] 周回顾 / 月回顾报表
- [ ] 屏幕使用时长统计（不是截屏，仅前台时间）

### P5 — 长期可选

- [ ] 双亲共管
- [ ] 企业微信小程序家长端
- [ ] 抽样人机验证（防刷终极手段）
- [ ] Mac 平台

------

## 22. 全部决策记录

| #    | 决策点                | 结论                                           | 设定章节 |
| ---- | --------------------- | ---------------------------------------------- | -------- |
| 1    | 后端基础设施          | 复用 三个管家 服务器                           | §2       |
| 2    | 子域名                | NinoGame.{现域名}                              | §2       |
| 3    | 推送渠道              | 企业微信机器人                                 | §2       |
| 4    | 多设备 DB             | DB 多设备 / UI 先单设备                        | §3       |
| 5    | 对孩子透明度          | 透明可见                                       | §1       |
| 6    | Watchdog 实现         | P1 Python                                      | §17      |
| 7    | 卸载密码              | 本地+云端 hash 双重                            | §17      |
| 8    | 配额档位              | 严守 / 平衡（默认） / 任务驱动 / 信任 / 自定义 | §6       |
| 9    | 离线策略              | 禁消费                                         | §7       |
| 10   | iOS 支持              | 不支持                                         | §11      |
| 11   | 使用上报间隔          | 5 分钟                                         | §10      |
| 12   | 孩子账号              | username + PIN + 设备绑定 + 关键操作二次 PIN   | §3       |
| 13   | 责任类任务            | 进系统 P1+，仅 checklist 不挣分                | §8.6     |
| 14   | 信任值机制            | P2 引入                                        | §8.7     |
| 15   | 应急放行              | 不设上限                                       | §8.5     |
| 16   | 多孩子 UI             | DB 预留 / UI P1 单孩子                         | §3       |
| 17   | Token 浮层默认        | 默认开，可关                                   | §15      |
| 18   | 微反思频率            | 每天前两次必问 + 20% 抽样                      | §15.6    |
| 19   | Forecast 默认         | 默认 Dashboard 显示                            | §15.5    |
| 20   | 资金紧张处理          | (C) 不主动救济                                 | §15.9    |
| 21   | 反思数据隐私          | 反思私有 / 趋势家长可见                        | §15.7    |
| 22   | 设备所有权            | child_primary / parent_primary / shared        | §4.1     |
| 23   | 共享设备默认          | Lock                                           | §4.3     |
| 24   | 孩子主用开机 PIN      | 不要 PIN，首次消耗 App 时 PIN                  | §4.3     |
| 25   | Parent Mode 自动 Lock | 不自动                                         | §4.3     |
| 26   | 家庭活动模式          | 取消，改家长限免活动                           | §14.4    |
| 27   | 调账可见性            | 孩子可见                                       | §14.5    |
| 28   | 闲置锁定 + 防刷       | 10 分钟 + 严格活跃判定                         | §10, §16 |
| 29   | LLM 翻译温度          | **待定**，默认冷静专业                         | §13.4    |
| 30   | P1 范围最小化         | Dashboard / 申请审批 / LLM / 跨端推迟到 P2     | §17.5.1  |
| 31   | 架构原则              | 接口先行，core/ 模块不直接接触存储/网络        | §17.5.2  |
| 32   | 拍照证据机制          | **下线**：改"私下协商确认 + 家长后台手动 +token" | §8.2, §12.4, §13 |
| 33   | 扣分模型              | **统一在线时长扣分**: child + 活跃 + 非限免 → 每分钟扣 N (settings.json 可调, 默认 1)。**Path 1 自动挣分下线**, 不再按 consumption/productive 分类。余额耗尽/硬上限**不再 kill 进程**, 仅弹通知。规则匹配 kill 不变。 | §7, §8.1, §10.2, §16 |
| 34   | 扣分权威源            | **server 单一权威**: Agent token_engine 每 tick 通过 WS `token_tick` 把扣分意图推给 server, server 写 ledger + UPDATE wallets + 推 `wallet_update` 回。Agent 本地不再 deduct, balance 完全由 server 推送驱动。`usage_report` 退化为纯审计 (写 app_sessions, 不再据 segments 减 wallet, 修复双重扣分)。离线时跳过扣分 (与 §7.6 一致)。 | §10, §11.2, §19 |
| 35   | 每日硬上限默认        | **取消默认 daily_hard_cap_minutes=120, 改 0=不限**: 决策 #33 已经把扣分和 active 时长绑定 (用就扣, 不够申请), 再叠加 "用满 N 分钟即停" 反而让孩子"卡到 X token 后免费玩剩下时间"。家长想用硬上限仍可手动设非 0 启用。 | §7.4, §10.2 |
| 36   | 取消活跃判定          | **child 模式在跑即扣**: 不再判定"最近 2 分钟有键鼠输入"。理由: 用户报"不管什么情况, 模式在运行就要扣费" (孩子看视频不动鼠也该扣)。闲置 10 分钟自动 Lock 仍兜底, 真正离开屏幕的场景由 Lock 停扣。`is_active_consumption` 函数保留但仅用于活跃事件流, 不参与扣分决策。 | §10.2, §10.3 |

------

## 23. 给后续 Claude 实例的工作指引

如果你是接手 NinoGame 项目的下一个 Claude 实例，请优先阅读本节。

### 23.1 不要扩张 scope

§1.4 明确了 non-goals。如果用户要求加超出范围的功能（如内容过滤、视频监控、网址拦截），先停下来确认，不要默默扩张。

### 23.2 保持透明原则

用户曾多次明确"不做隐藏化"。如果未来出现"让程序更难被发现"的需求，回到 §1.4 和 §17.2 重新确认，不要直接实现。

### 23.3 守住"系统逐步退场"的设计哲学

§1.2 是整个项目的灵魂。任何功能设计都要问：**这个功能是在让系统更强势地长期存在，还是在为未来的退场做准备？** 比如：

- ✅ 信任值机制 → 让系统逐步放手
- ✅ 反思数据孩子私有 → 让孩子建立自我对话
- ✅ Forecast → 培养时间感
- ❌ 加屏幕录制 → 强化监控感，逆向走
- ❌ 自动判定孩子撒谎 → LLM 不该当裁判

### 23.4 优先 P1 不跳 P2

用户工程偏好是"可发布的最小单元"，每阶段独立交付。**不要先把后端写完才让 Agent 能跑。**

### 23.5 复用现有基础设施

三个管家 已经在用 1Panel + Postgres + Node。新组件优先复用，**不要无谓引入新技术栈**（不需要 K8s、Redis Cluster、消息队列、独立 Caddy/Nginx 等）。反代用 1Panel 自带 OpenResty 即可，不占 80/443。

### 23.6 代码风格匹配作者

作者偏好 Python + 直接、可读的代码。**不要为了"优雅"过度抽象**（不要工厂模式包工厂模式）。

### 23.7 LLM 是助手不是裁判

§12.5 的原则要严守：LLM 永远不替家长直接做"批准/拒绝"决策。LLM 翻译、初筛、摘要，决策权始终在家长。

### 23.8 防滥用机制不等于战争

§16 的防滥用是给"非技术党孩子"设的合理摩擦，不是与孩子开战。**如果用户提出更激进的反作弊手段（如硬件指纹、内核钩子），回到 §17.3 重新确认是否值得**。

### 23.9 决策前查 §22

如果遇到设计权衡，先查决策表。表里没有的再问用户。表里有的不要轻易翻案——这些都是讨论过的结果。

### 23.10 更新本文档

每完成一个里程碑：

- 更新 §21 的勾选状态
- 更新 §22 的新决策（如有）
- 在 §0 标注当前版本号（v0.3 / v0.4 ...）
- 必要时增补章节，但不要重组现有结构

### 23.11 文档之外的代码参考

- P0 脚本 `pvz_monitor.py` 是当前唯一可运行代码，作为 P1 的起点和关键词词表的初始数据源
- P1 第一步：把 `find_targets()` 函数拆为 `monitor.py`（产生 ProcessSnapshot）+ `rule_engine.py`（评估规则），把硬编码的 KEYWORDS 列表转为 JSON 规则配置
- P1 完整模块结构、接口契约、SQLite schema 见 §17.5

### 23.12 接口先行是硬约束

P1 实现必须遵守 §17.5.2-17.5.4 的接口契约：

- **业务模块（`core/`）禁止直接调用 SQLite、文件系统、HTTP/WS**
- 所有 IO 走 `RuleRepository` / `WalletService` / `EventSink` / `Transport` 接口
- 这是 P1→P2 平滑过渡的硬约束

如果发现某个核心模块绕过接口直接操作存储——**这是 bug 不是 feature**。原则上 P2 接入时，`core/` 下不应有任何文件需要修改，只是注入新的 Repository / Transport 实现。如果某次 P2 改动牵连到 core/ 里的业务代码，先停下来检查接口设计是否漏了。

### 23.13 P1 写代码顺序按 §17.5.6

不要并行开搞所有模块。Step 1（数据层）必须先完成，否则后面所有模块测试都会卡在 mock 上。Step 4 完成后建议先停一下走通 PyInstaller + NSSM，验证打包链路再继续。

------

**文档维护者：** Zeroer **起草助手：** Claude（多轮设计讨论结晶） **项目愿景一句话：** 给孩子搭一个能逐步拆除的脚手架。
