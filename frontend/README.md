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

生产部署方案两选一：
1. **1Panel 网站**：把 `dist/` 拷到 1Panel 一个静态网站目录，配 nginx 反代 `/auth` `/api` `/ws` 到 backend 容器
2. **Backend 直接 serve**（后续可加）：Backend 加个 static handler 把 `dist/` serve 出来

## 设计

- 配色与 Agent UI 一致（`#1ea7c4` 蓝、`#66c596` 绿、`#d96a3c` 警告）
- 字体 Microsoft YaHei UI / PingFang SC
- 图标用 [lucide-react](https://lucide.dev/)（轻量 SVG，跟 Agent 端 qtawesome 同风格）
