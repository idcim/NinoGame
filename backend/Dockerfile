# ─── stage 1: build ────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# 先装依赖 (利用 docker layer cache)
COPY package*.json tsconfig.json ./
RUN npm ci

# 拷代码 + 编译
COPY src ./src
COPY sql ./sql
RUN npm run build

# ─── stage 2: runtime (slim) ───────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 仅装 production 依赖, 减小体积
COPY package*.json ./
RUN npm ci --omit=dev

# 拷编译产物 + migrations
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/sql  ./sql

# 入口脚本: 先跑 migration, 再起 server
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 8088

# 健康检查 — 1Panel / docker 自带 healthcheck 显示
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8088/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
