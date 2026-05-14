# ─── stage 1: build ────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json vite.config.ts tailwind.config.ts postcss.config.js index.html ./
RUN npm ci

COPY src ./src
COPY public ./public
RUN npm run build

# ─── stage 2: runtime (nginx) ──────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# 拷编译产物 + nginx 配置
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1/ || exit 1

# 使用 nginx 默认的 entrypoint, 不需要 envsubst (静态 conf)
