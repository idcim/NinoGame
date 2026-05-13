# NinoGame 家长后台 (frontend)

Vite + React 18 + TypeScript + Tailwind CSS。提供 P2 必要的家长可视化操作：
登录 / 查看孩子 / 设备配对 / 远程命令（临时放行 PvZ / 锁定）。

## 本地开发

```powershell
# 1) 先起 backend (另一个窗口)
cd ..\infra
docker compose up -d

# 2) frontend dev server (5173)
cd ..\frontend
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:5173/ → 注册第一个家长账号 → 创建孩子 → 生成配对码。

Vite dev server 自动把 `/auth` / `/api` / `/ws` 代理到 `127.0.0.1:8088`（backend）。

## 已有页面

| 路径 | 内容 |
|---|---|
| `/login` | 家长登录 / 注册（同一表单切换） |
| `/` | 概览：孩子列表 + 余额 + 设备列表 |
| `/device/:id` | 设备详情：临时放行 PvZ（10/30/60 分钟）+ 立即锁定 + 命令历史 |

## 待补全

- WebSocket 实时事件流（孩子拦截 / token 变动）
- 规则编辑（直接改 server 的 `NinoGame.rules` 表）
- 任务模板 + 申请审批 UI
- 数据报表 / 反思页

## 生产构建

```powershell
npm run build
# 输出 dist/ - 静态文件
```

### 推荐方式: Docker 一起部署 (跟 backend 同 compose)

本地预览生产版本:
```powershell
cd ..\infra
docker compose up -d --build
# 浏览器: http://127.0.0.1:8080/
```

3 个容器一起跑：
- `ninogame-postgres` — 数据库 (127.0.0.1:5433)
- `ninogame-backend` — Fastify (127.0.0.1:8088)
- `ninogame-frontend` — nginx 静态 + 反代 (127.0.0.1:8080)

Frontend 容器 nginx 配置 (`frontend/nginx.conf`)：
- `/auth` `/api` `/health` → 反代到 `ninogame-backend:8088`
- `/ws/*` → 反代 + 加 `Upgrade` 头, 支持 WebSocket
- SPA fallback：未匹配路径返回 `index.html`
- `/assets/` 长缓存 7d；`index.html` no-cache 保证发版立即生效

### 1Panel 部署

跑 `docker-compose.prod.yml`, 两个容器都加入 `1panel-network`:

```bash
cd /opt/NinoGame/infra
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

1Panel 后台建网站 → 反向代理 → `http://ninogame-frontend:80`, 勾上 WebSocket 支持, 申请证书即可。详见 `infra/README.md`。

## 设计

- 配色与 Agent UI 一致（`#1ea7c4` 蓝、`#66c596` 绿、`#d96a3c` 警告）
- 字体 Microsoft YaHei UI / PingFang SC
- 图标用 [lucide-react](https://lucide.dev/)（轻量 SVG，跟 Agent 端 qtawesome 同风格）
