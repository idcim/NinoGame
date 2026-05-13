# 诊断 "重新生成配对码 404" 问题
# 用法: .\diag-pair.ps1 -Username 你的家长用户名 -Password 你的密码

param(
    [string]$BaseUrl = "http://127.0.0.1:8080",
    [string]$BackendUrl = "http://127.0.0.1:8088",
    [string]$Username = "",
    [string]$Password = ""
)

function Test-Endpoint {
    param([string]$Url, [string]$Method = "GET", [hashtable]$Headers = @{}, [string]$Body = $null)
    try {
        $params = @{
            Uri = $Url
            Method = $Method
            Headers = $Headers
            ErrorAction = "SilentlyContinue"
            UseBasicParsing = $true
            SkipHttpErrorCheck = $true
        }
        if ($Body) {
            $params.Body = $Body
            $params.ContentType = "application/json"
        }
        $r = Invoke-WebRequest @params
        return @{ Code = $r.StatusCode; Body = $r.Content }
    } catch {
        return @{ Code = "ERR"; Body = $_.Exception.Message }
    }
}

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " NinoGame regenerate-pair 404 诊断" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# 1) 容器跑没跑
Write-Host "[1] Docker 容器状态" -ForegroundColor Yellow
docker ps --filter "name=ninogame" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Write-Host ""

# 2) backend 直连测路由存在不
Write-Host "[2] Backend 直连 $BackendUrl/ 看路由列表" -ForegroundColor Yellow
$h = Test-Endpoint -Url "$BackendUrl/"
if ($h.Code -eq 200) {
    $obj = $h.Body | ConvertFrom-Json
    $hasRoute = $obj.endpoints | Where-Object { $_ -match "regenerate" }
    if ($hasRoute) {
        Write-Host "    ✓ backend 上有 regenerate-pair 路由: $hasRoute" -ForegroundColor Green
    } else {
        Write-Host "    × backend 没有 regenerate-pair 路由 → 镜像没重建!" -ForegroundColor Red
        Write-Host "       修法: docker compose up -d --build backend" -ForegroundColor Red
    }
} else {
    Write-Host "    × backend $BackendUrl 不通: $($h.Code) $($h.Body)" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 3) frontend 静态页 + API 反代
Write-Host "[3] Frontend nginx $BaseUrl 静态页 + 反代" -ForegroundColor Yellow
$front = Test-Endpoint -Url "$BaseUrl/"
if ($front.Code -eq 200 -and $front.Body -match "NinoGame") {
    Write-Host "    ✓ frontend 容器 OK (返回 index.html)" -ForegroundColor Green
} else {
    Write-Host "    × frontend $BaseUrl 异常: $($front.Code)" -ForegroundColor Red
}
$healthThruNginx = Test-Endpoint -Url "$BaseUrl/health"
if ($healthThruNginx.Code -eq 200) {
    Write-Host "    ✓ nginx 反代 /health → backend OK" -ForegroundColor Green
} else {
    Write-Host "    × nginx 反代失败: $($healthThruNginx.Code)" -ForegroundColor Red
}
Write-Host ""

# 4) 完整流程
if (-not $Username -or -not $Password) {
    Write-Host "[4] 跳过完整流程 (没传 -Username / -Password)" -ForegroundColor DarkYellow
    Write-Host "    要测请重跑: .\diag-pair.ps1 -Username 你的用户名 -Password 你的密码" -ForegroundColor DarkYellow
    exit 0
}

Write-Host "[4] 完整流程: 登录 → 列设备 → 重生配对码" -ForegroundColor Yellow
$loginBody = @{ username = $Username; password = $Password } | ConvertTo-Json -Compress
$login = Test-Endpoint -Url "$BaseUrl/auth/parent/login" -Method "POST" -Body $loginBody
if ($login.Code -ne 200) {
    Write-Host "    × 登录失败: $($login.Code) $($login.Body)" -ForegroundColor Red
    exit 1
}
$token = ($login.Body | ConvertFrom-Json).token
Write-Host "    ✓ 登录 ok, token: $($token.Substring(0,20))..." -ForegroundColor Green

$auth = @{ "Authorization" = "Bearer $token" }
$devs = Test-Endpoint -Url "$BaseUrl/api/devices" -Headers $auth
if ($devs.Code -ne 200) {
    Write-Host "    × 列设备失败: $($devs.Code)" -ForegroundColor Red
    exit 1
}
$devices = ($devs.Body | ConvertFrom-Json).devices
if ($devices.Count -eq 0) {
    Write-Host "    × 还没有设备, 先配对一台再测" -ForegroundColor Yellow
    exit 0
}
$deviceId = $devices[0].id
Write-Host "    ✓ 找到设备: $deviceId" -ForegroundColor Green

$regen = Test-Endpoint -Url "$BaseUrl/api/devices/$deviceId/regenerate-pair" -Method "POST" -Headers $auth
if ($regen.Code -eq 200) {
    $r = $regen.Body | ConvertFrom-Json
    Write-Host "    ✓ regenerate-pair 200 OK, 新码: $($r.pairing_code)" -ForegroundColor Green
    Write-Host ""
    Write-Host "===> 后端 + nginx + API 全部正常!" -ForegroundColor Green
    Write-Host "     你浏览器看到 404 → 八成是浏览器缓存了旧 JS" -ForegroundColor Green
    Write-Host "     修法: 浏览器按 Ctrl+Shift+R 强制刷新" -ForegroundColor Green
} else {
    Write-Host "    × regenerate-pair 失败: $($regen.Code)" -ForegroundColor Red
    Write-Host "      $($regen.Body)" -ForegroundColor Red
}
