import { Heart, Info, ScrollText, Sprout } from "lucide-react";

/** 关于我们 + 更新日志。
 *
 * 静态页, 不依赖后端数据。changelog 每次发版手动补一行。
 */
export default function About() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <Info size={22} className="text-brand" />
          关于 NinoGame
        </h1>
        <p className="text-sm text-ink-dim mt-1">
          一句话: 给孩子搭一个能逐步拆除的脚手架。
        </p>
      </div>

      <section className="card p-6 space-y-4">
        <h2 className="text-base font-bold text-ink flex items-center gap-2">
          <Sprout size={18} className="text-accent-600" />
          这是什么
        </h2>
        <p className="text-sm text-ink leading-relaxed">
          NinoGame 是一套跨端（Windows + Android）的<b>家长控制 + 自我管理培养</b>系统。
          表层功能是监控并拦截孩子使用未授权的应用（首期场景：植物大战僵尸全变种）；
          深层功能是通过 token 经济、任务系统、申请审批、自我反思工具，
          让孩子在系统的"脚手架"上逐步学会自我管理。
        </p>
      </section>

      <section className="card p-6 space-y-4">
        <h2 className="text-base font-bold text-ink flex items-center gap-2">
          <Heart size={18} className="text-warn" />
          设计哲学：让系统逐步退场
        </h2>
        <p className="text-sm text-ink leading-relaxed">
          一个永远不退场的控制系统会把孩子训练成"如何对抗系统"。
          NinoGame 的最终目标是让孩子在 16 岁前后能自己掌控时间分配，
          那么这套软件本质上是<b>临时脚手架</b>。
        </p>
        <ul className="text-sm text-ink-dim space-y-1.5 list-disc pl-5">
          <li><b>结构是脚手架，不是牢笼</b> —— 像训练轮，目标是被卸下</li>
          <li><b>可见性优于强制力</b> —— 孩子能看见规则、可协商、可申请</li>
          <li><b>协商接口而非控制器</b> —— 让家庭沟通变得低摩擦，而不是被技术阻断</li>
          <li><b>机制承载价值观</b> —— token 费率系数、信任值机制本身就传达价值</li>
          <li><b>承认系统有边界</b> —— 学校设备 / 朋友家电脑 / 网页云游戏等场景管不到，靠对话不靠技术</li>
        </ul>
        <p className="text-xs text-ink-light pt-2 border-t border-border">
          四档<b>成熟度模式</b>对应不同年龄阶段:
          严管 (6-10 岁) → 协商 (10-13 岁) → 建议 (13-16 岁) → 自管 (16+);
          同一套代码服务整个成长周期，UI 与权限随档位演化。
        </p>
      </section>

      <section className="card p-6 space-y-4">
        <h2 className="text-base font-bold text-ink">不做的事 (Non-goals)</h2>
        <ul className="text-sm text-ink-dim space-y-1 list-disc pl-5">
          <li>不做内容过滤 (网址黑名单 / 浏览器拦截) — 浏览器层有现成方案</li>
          <li>不做完整 MDM (屏幕录制 / 键盘记录) — 隐私和复杂度太高</li>
          <li>不做反检测 / 隐藏化 — 保持透明可审计</li>
          <li>不做账号生态 — 自用工具，不做 SaaS</li>
          <li>不强制覆盖所有设备 — 跟着孩子主用设备走</li>
          <li>不替代家庭沟通 — 系统是协商工具，不是判官</li>
          <li>LLM 是助手不是裁判 — 决策权始终在家长</li>
        </ul>
      </section>

      <section className="card p-6 space-y-4">
        <h2 className="text-base font-bold text-ink flex items-center gap-2">
          <ScrollText size={18} className="text-brand" />
          更新日志
        </h2>
        <div className="space-y-4">
          {CHANGELOG.map((entry) => (
            <article key={entry.tag} className="border-l-2 border-brand-50 pl-4">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-xs font-mono text-ink-light">{entry.tag}</span>
                <span className="text-sm font-semibold text-ink">{entry.title}</span>
              </div>
              <ul className="text-xs text-ink-dim mt-1 space-y-0.5 list-disc pl-4">
                {entry.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <footer className="text-xs text-ink-light pt-4 border-t border-border">
        <p>
          维护者: Zeroer · 起草助手: Claude (多轮设计讨论结晶) ·
          {" "}<a className="underline hover:text-brand" href="https://github.com/idcim/NinoGame" target="_blank" rel="noreferrer">源码</a>
        </p>
      </footer>
    </div>
  );
}

/** 更新日志手动维护; 每次有意义的版本更新追加一项。 */
const CHANGELOG: Array<{ tag: string; title: string; bullets: string[] }> = [
  {
    tag: "2026-05-14 b",
    title: "全局通知 + 报表页 + 扣分上限取消",
    bullets: [
      "新增: 全局 toast — 任意页面收到 task_claim / unlock_request / behavior_anomaly / block / jiggler_alert 都弹右上角提示, 点击跳转对应页",
      "新增: 顶部导航「申请」/「任务」链接红色 badge 显示 pending 数量, 每 30s 轮询 + 事件触发即时刷新",
      "新增: 家长后台 /reports 报表页 — 14 天柱状图 + Top 应用列表 + 总 active 时长 / 日均 / 总扣 token 汇总",
      "改: 决策 #35 — daily_hard_cap_minutes 默认 0 = 不限 (原 120 让孩子「卡 X token 后免费」), 老 settings.json 自动迁移",
      "修: 服务端单一权威扣分 (token_tick WS) + Agent 本地不再 deduct, 余额完全 server 驱动 — 不一致根治",
      "修: 托盘菜单「申请游戏时间」/「申报任务完成」/「我的消息」/「余额变动」点了没反应 (pystray 工作线程 QTimer 静默失败 → 改 bridge run_on_gui)",
    ],
  },
  {
    tag: "2026-05-14",
    title: "扣分模型简化 (CLAUDE.md §22 决策 #33)",
    bullets: [
      "改: 统一在线时长扣分 — child 模式 + 活跃 (最近 2 分钟有输入) + 非限免 → 每分钟扣 1 token (settings.json 可调)",
      "改: 不再按 consumption / productive 区分前台, app_categories.rate_multiplier 字段保留但不参与决策",
      "下线: Path 1 自动挣分 (Kindle / VSCode / Duolingo 等学习类按时长自动 +token)。挣分只走申报 / 任务 / 家长发奖",
      "改: 余额耗尽 / 每日硬上限不再 kill 前台进程, 仅一天一次通知; 规则匹配 kill (PvZ 类) 不变",
      "新增: 设备详情页「Agent 实时状态」卡显示前台/分类/余额/本 tick 结果, 6 种 skip_reason 中文解释",
      "记忆: 重要决策必须沉淀到 CLAUDE.md §22, 防止后续会话又走老路",
    ],
  },
  {
    tag: "2026-05-13",
    title: "申请-批准放行链路修复 + UI 清理",
    bullets: [
      "修复: 申请时间放行失效 (rule_id 硬编码 vs server UUID 不匹配; 现在批准展开为该孩子全部 enabled 规则)",
      "新建孩子时自动 seed 默认 PvZ 规则 (家长开箱即用); 老孩子启动时补 seed",
      "移除孩子端「主动锁定/解锁」UI (面板按钮 + 托盘菜单项); 闲置自动 Lock + 远程 lock_device 保留",
      "调账三连修复: Agent 全 reason 通知 / 后台 ledger 历史页 / 浏览器实时余额刷新",
      "新增「关于我们」页 + 更新日志 (本页)",
      "退出 Agent 时 Watchdog 跟着退 (写 agent_quit.flag 标记)",
      "在线历史按天分层: 默认日聚合, 点开看碎片",
    ],
  },
  {
    tag: "v0.5",
    title: "时间窗口规则 + 行为基线告警",
    bullets: [
      "P3: 时间窗口规则 (schedule.windows): 始终生效 / 仅指定时段 / 暂停; 跨午夜支持",
      "P2: 行为基线异常告警 (§16.1 ④): 每小时扫 child×category, 今日 >2x 14 天均值即报警",
      "下线拍照证据机制 (§22 #32): 改「私下协商 + 家长后台手动 +token」",
    ],
  },
  {
    tag: "v0.4",
    title: "限免活动 + 信任值 + 申请审批",
    bullets: [
      "限免活动 (§14.4): 一键放行 30 / 60 / 120 分钟, consumption 跳扣 token",
      "信任值机制 (§8.7): 30 天审批窗口驱动 ±1 等级, 24h 冷却",
      "申请-审批流 (§13) 端到端: Agent 申请 → 浏览器审批 → temporary_unlock",
      "鼠标抖动器检测 (§16.1 ②) + usage_report 服务端聚合 + 调账可见性",
    ],
  },
  {
    tag: "v0.3",
    title: "P2 远程控制 MVP",
    bullets: [
      "Node + Fastify + Postgres 三容器 docker compose, 1Panel 反代",
      "React 家长后台 (登录 / 设备 / 规则 / 任务 / 申请 / 事件流)",
      "Agent ↔ Backend WebSocket: rules / wallet / commands 实时同步",
      "每日 token 发放搬服务端 (幂等, Agent 离线 fallback)",
    ],
  },
  {
    tag: "v0.2 (P1)",
    title: "本地 Agent 模块化 + 打包",
    bullets: [
      "接口先行重构: core / store / comms / protector / ui 分层",
      "SQLite 审计日志 + Watchdog 互守 + PyInstaller folder 模式打包",
      "Token 经济本地版 (基础日额 / 消费扣分 / Path 1 自动赚分)",
      "责任清单 + 严格活跃判定 + 单日 token 上限兜底",
    ],
  },
  {
    tag: "v0.1 (P0)",
    title: "PvZ 全变种关键词拦截",
    bullets: [
      "本地单文件脚本 pvz_monitor.py",
      "三层匹配: 进程名 / 可执行路径 / 窗口标题",
      "异步弹窗 + 自动 kill",
    ],
  },
];
