#!/bin/sh
# 当 docker.io 默认镜像源被墙时, 从可用 mirror 拉 base image + 打本地 tag
# 用法: ./pull-base-images.sh [mirror]
#   默认 mirror = docker.m.daocloud.io
#
# 跑一次后, docker compose build 直接用本地缓存, 不再访问外网。
#
# Windows 用户可在 git bash / WSL 跑; 或参考下面的 PowerShell 等价命令:
#   docker pull docker.m.daocloud.io/library/node:20-alpine
#   docker tag  docker.m.daocloud.io/library/node:20-alpine node:20-alpine
#   (postgres / nginx 同理)
set -e

MIRROR="${1:-docker.m.daocloud.io}"

# 项目用到的 base images
IMAGES="
node:20-alpine
nginx:1.27-alpine
postgres:15-alpine
"

echo "===> 使用 mirror: $MIRROR"
echo ""

for img in $IMAGES; do
    src="$MIRROR/library/$img"
    echo "---> docker pull $src"
    if docker pull "$src"; then
        echo "     docker tag $src $img"
        docker tag "$src" "$img"
        echo "     ✓ $img 已就绪"
    else
        echo "     × $img 拉取失败 (尝试其他 mirror 或直接修 daemon.json)"
    fi
    echo ""
done

echo "===> 全部完成。现在可以 docker compose up -d --build"
