# NinoGame 本地基础设施

P2 Backend 用的 PostgreSQL 通过 Docker 提供。生产环境复用 三个管家 服务器的 1Panel 管理的 Postgres，本地 Docker 仅用于开发。

## 启动数据库

```powershell
cd G:\DEL_GAME\infra
docker compose up -d
```

启动后：

- 监听 `127.0.0.1:5433`（只绑本机）
- 数据库 `ninogame`，用户 `ninogame`，密码 `ninogame_dev`
- 业务 schema `NinoGame`（大小写敏感，SQL 里用双引号）
- 数据卷 `ninogame-pgdata`（停容器不删数据）

## 连接验证

```powershell
docker exec -it ninogame-postgres psql -U ninogame -d ninogame -c "\dn"
```

应看到 `NinoGame` schema 已建。

或用本机 psql：

```powershell
psql "postgresql://ninogame:ninogame_dev@localhost:5433/ninogame" -c "SHOW search_path;"
```

## pgAdmin（可选 GUI）

```powershell
docker compose --profile gui up -d
```

浏览器打开 http://127.0.0.1:5050，登录：

- 邮箱：`admin@ninogame.local`
- 密码：`ninogame_dev`

新建 Server：Host `postgres`（容器名）、Port `5432`、User/Pass 同上。

## 关停

```powershell
docker compose down            # 保留数据
docker compose down -v         # 连数据一起清（小心）
```

## 与生产的差异

| 项 | 本地 Docker | 生产（1Panel） |
|---|---|---|
| 端口 | 5433 | 1Panel 内部端口，OpenResty 反代 |
| 密码 | `ninogame_dev`（写死，仅本机） | 强密码，存 1Panel 凭据 |
| TLS | 无（仅 127.0.0.1） | 1Panel 终结 |
| 备份 | 无 | 1Panel 计划任务 |

迁移到生产时只换连接串，schema/表结构走同一套迁移脚本。
