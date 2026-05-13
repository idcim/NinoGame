# NinoGame 基础设施

支持两种部署：
- **本地开发**：docker-compose 一起拉起 Postgres + Backend
- **1Panel 生产**：Backend 容器加入 `1panel-network`，复用 1Panel 的 Postgres + 反向代理 + TLS

## 本地开发

```powershell
cd G:\DEL_GAME\infra
docker compose up -d
```

> ⚠ **如果拉镜像超时 / 报 `EOF` / 镜像源被墙**
>
> 国内 docker hub 镜像不稳定。三种修法 (按推荐度):
>
> **A) 永久修 — 改 daemon.json (1Panel 后台 → Docker → 配置 → 镜像加速):**
> ```json
> {
>   "registry-mirrors": [
>     "https://docker.m.daocloud.io",
>     "https://docker.1ms.run",
>     "https://dockerproxy.com",
>     "https://hub-mirror.c.163.com"
>   ]
> }
> ```
> 改完 1Panel 里点"重启 Docker" (或 `sudo systemctl restart docker`)。
>
> **B) 临时 — 跑预拉脚本:**
> ```powershell
> .\pull-base-images.ps1
> # 或 git bash: ./pull-base-images.sh
> ```
> 脚本会从 `docker.m.daocloud.io` 拉 `node:20-alpine` / `nginx:1.27-alpine` /
> `postgres:15-alpine` 并打本地 tag, 之后 `docker compose build` 用本地缓存。
>
> **C) 一次性 — 手动:**
> ```powershell
> docker pull docker.m.daocloud.io/library/node:20-alpine
> docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine
> # nginx / postgres 同理
> ```

启动后：

| 服务 | 监听 | 用途 |
|---|---|---|
| `ninogame-postgres` | `127.0.0.1:5433` | 数据库 |
| `ninogame-backend` | `127.0.0.1:8088` | Fastify + WebSocket |
| `ninogame-frontend` | `127.0.0.1:8080` | nginx 静态 + 反代 |

验证：
```powershell
curl http://127.0.0.1:8088/health      # backend 直连
curl http://127.0.0.1:8080/health      # 经 frontend nginx 反代
浏览器: http://127.0.0.1:8080/         # 完整家长后台
```

第一次启动时 backend 容器的 entrypoint 会自动跑 schema migration（21 张表）。后续启动幂等。

frontend 容器的 nginx 在容器网络内通过 `ninogame-backend:8088` 找 backend，把 `/auth /api /health /ws` 都反代过去。整套部署后只需要一个域名（指向 frontend 容器），不用单独暴露 backend 端口给公网。

### 改代码后

代码改完要 rebuild：
```powershell
docker compose up -d --build backend
```

或者本地用 `npm run dev` 热重启（把 compose 里 backend 停了避免端口冲突）：
```powershell
docker compose stop backend
cd ..\backend
npm run dev
```

### pgAdmin（可选 GUI）

```powershell
docker compose --profile gui up -d
```

浏览器：http://127.0.0.1:5050（`admin@ninogame.local` / `ninogame_dev`）

### 停 / 重置

```powershell
docker compose down              # 保留数据
docker compose down -v           # 数据一起删（小心）
```

---

## 1Panel 生产部署

前提：你的 1Panel 已经装好，并有一个 Postgres 容器（应用商店一键装）。

### 1) 拷代码 + 配置

```bash
# SSH 到服务器
cd /opt
git clone https://github.com/idcim/NinoGame.git
cd NinoGame/infra
cp .env.prod.example .env.prod
nano .env.prod  # 填实际 DATABASE_URL 和 JWT_SECRET
```

`.env.prod` 关键字段：

```ini
DATABASE_URL=postgresql://ninogame:你的强密码@1panel-postgresql:5432/ninogame
JWT_SECRET=$(openssl rand -hex 32 生成的长字符串)
NETWORK_NAME=1panel-network
```

> **Postgres 准备**：在 1Panel 后台的 Postgres 容器里：
> 1. 建数据库 `ninogame`
> 2. 建用户 `ninogame` 并授权该库
> 3. 1Panel 里看 Postgres 容器名（通常是 `1panel-postgresql-{n}`），改到 DATABASE_URL host 部分

### 2) 启动 Backend 容器

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

容器自动：
- 加入 `1panel-network`（跟 1Panel 反代和其他 1Panel 容器同网络）
- entrypoint 跑一次 migration
- 起 Fastify on `0.0.0.0:8088`
- 容器名 `ninogame-backend`（1Panel 反代用这个 hostname）

### 3) 1Panel 后台配反向代理

进 1Panel → 网站 → 创建网站 → 反向代理：

| 字段 | 值 |
|---|---|
| 域名 | `ninogame.你的域名` |
| 代理 URL | **`http://ninogame-frontend:80`** (而非 backend, frontend 容器 nginx 已内部反代到 backend) |
| **WebSocket** | ✅ 务必勾选 |

然后申请 Let's Encrypt 证书。完成后 `https://ninogame.你的域名/health` 应该能返回 JSON。

### 4) Agent 端连线上 Backend

```powershell
# 在家长端先后台 curl 取配对码:
curl -X POST https://ninogame.你的域名/api/devices/pair \
  -H "Authorization: Bearer 家长token" \
  -d '{"child_id":"..."}'

# Agent 端 (孩子电脑) 跑 pair.py:
python agent\pair.py https://ninogame.你的域名 8位配对码
```

Agent 会用 `wss://ninogame.你的域名/ws/agent` 连后端。

### 升级（代码改了重新部署）

```bash
cd /opt/NinoGame
git pull
cd infra
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

入口脚本会自动跑新的 migration（如果有）。

---

## 故障排查

```bash
# 看 backend 日志
docker logs -f ninogame-backend

# 看健康
docker inspect ninogame-backend --format '{{.State.Health.Status}}'

# 进容器
docker exec -it ninogame-backend sh

# 手动跑 migration
docker exec ninogame-backend npx node-pg-migrate -j sql -m sql -d DATABASE_URL up

# 看 1Panel 反代的 nginx 配置 (1Panel 后台 -> 网站 -> 详情 -> 日志)
```

常见问题：

| 现象 | 原因 / 排查 |
|---|---|
| `connection refused` 连 postgres | DATABASE_URL host 写错；进容器 `ping <host>` 试连 |
| 1Panel 反代 502 | backend 容器没起 / 不在同一网络；`docker network inspect 1panel-network` 看 |
| WebSocket 失败 | 1Panel 反代没勾 WebSocket；OpenResty 配置缺 `Upgrade` 头 |
| migration 失败 | 看 `docker logs ninogame-backend` 首行 `[entrypoint]` 输出 |
