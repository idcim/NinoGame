# PowerShell 版本: docker.io 镜像源不通时拉 base image + 本地 tag
# 用法: .\pull-base-images.ps1 [-Mirror docker.m.daocloud.io]

param(
    [string]$Mirror = "docker.m.daocloud.io"
)

$images = @(
    "node:20-alpine"
    "nginx:1.27-alpine"
    "postgres:15-alpine"
)

Write-Host "===> 使用 mirror: $Mirror"
Write-Host ""

foreach ($img in $images) {
    $src = "$Mirror/library/$img"
    Write-Host "---> docker pull $src"
    docker pull $src
    if ($LASTEXITCODE -eq 0) {
        docker tag $src $img
        Write-Host "     OK $img 已就绪"
    } else {
        Write-Host "     FAIL $img 拉取失败 (换 mirror 或修 daemon.json)"
    }
    Write-Host ""
}

Write-Host "===> 全部完成。现在可以 cd .. ; docker compose up -d --build"
