# NinoGame Backend (P2)

Node 20 + Fastify 4 + Postgres 15 + WebSocket。承担:
- 家长 / 孩子账号 + 设备配对 + JWT
- REST CRUD: 规则 / 任务 / 钱包 / 事件
- WebSocket Agent 长连接
- LLM 翻译 / 分类 / 验证

详见 [CLAUDE.md §2 / §18 / §19 / §20.3](../CLAUDE.md)。

## 首次启动

1. 启动本地 Postgres (一次):
   ```powershell
   cd ../infra
   docker compose up -d
   ```

2. 装依赖 + 准备 .env:
   ```powershell
   cd ../backend
   npm install
   copy .env.example .env
   ```

3. 跑 schema migration:
   ```powershell
   npm run migrate:up
   ```

4. 起 dev server (watch + 热重启):
   ```powershell
   npm run dev
   ```

5. 验证:
   ```powershell
   curl http://127.0.0.1:8088/health
   ```

## 目录结构

```
backend/
├── src/
│   ├── config.ts       # 环境变量
│   ├── db.ts           # pg pool
│   ├── server.ts       # Fastify app
│   └── index.ts        # 入口
├── sql/                # node-pg-migrate 的 SQL migration
│   └── *_initial_schema.sql
├── package.json
├── tsconfig.json
└── .env.example
```

## Migration

用 [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) 管:

```powershell
npm run migrate:up        # 应用所有未跑的 migration
npm run migrate:down      # 回滚最新一个 (开发用)
npm run migrate:status    # 看 migration 列表
```

新增 migration 直接在 `sql/` 下加一个 `<timestamp>_<name>.sql` 文件,
里面用 `-- Up Migration` / `-- Down Migration` 分隔 up/down。

## 部署到生产 (§20.3)

1. `npm run build` 编译到 `dist/`
2. PM2 / 1Panel 启动 `node dist/index.js`
3. 进程绑 `127.0.0.1:8088` (不直接暴露公网)
4. 1Panel OpenResty 反代 `https://NinoGame.{现域名}` → `127.0.0.1:8088`
5. WebSocket 反代关键: `proxy_http_version 1.1; Upgrade/Connection` 头要带

## 实施进度

- [x] 骨架: package.json / tsconfig / config / db pool / Fastify / /health
- [x] Migration: §18 全部 21 表
- [x] Auth: 家长 register/login/me (bcrypt + JWT)
- [x] Children CRUD (创建 + 列出, 含余额联合查询)
- [x] Devices: 家长生成 8 位配对码 + Agent 兌换 agent_token (256-bit) + 列设备
- [x] WebSocket `/ws/agent`: hello / hello_ack / heartbeat / event 入库
- [ ] WebSocket: usage_report 聚合 + commands 派发
- [ ] WebSocket: 服务端主动推 rules_update / wallet_update
- [ ] LLM service (§12)

## 已验证的 E2E 流程

```bash
# 1) 家长注册
POST /auth/parent/register {"username":"...","password":"..."}
  → {token, parent}

# 2) 创建孩子
POST /api/children (Bearer)  {"username":"nino","display_name":"Nino","birth_year":2015}
  → {id, ...} + 自动建钱包

# 3) 家长生成配对码
POST /api/devices/pair (Bearer)  {"child_id":"..."}
  → {device_id, pairing_code: "FUJAKC9E", expires_in_minutes: 30}

# 4) Agent 兑换码
POST /api/devices/pair/redeem  {"code":"FUJAKC9E","platform":"windows"}
  → {agent_token, device_id, child_id}

# 5) Agent WebSocket 连接
ws://127.0.0.1:8088/ws/agent?token=<agent_token>
  Agent → server: {type:"hello", payload:{agent_version}}
  server → Agent: {type:"hello_ack", payload:{rules, wallet_balance, pending_commands}}
  Agent → server: {type:"event", payload:{event_type:"block", payload:{...}}}
    → 入库到 NinoGame.events
```

测试脚本: `npm run dev` 起服务后, 跑 [手工 curl + node WS 客户端](https://github.com/idcim/NinoGame/commit/) 验证。
