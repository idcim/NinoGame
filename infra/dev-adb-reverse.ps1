# Android 真机 dev 反向端口转发 — 手机/模拟器 localhost:N → PC 127.0.0.1:N
#
# 为什么用 adb reverse 而非 LAN IP / portproxy:
#   - Docker Desktop on Windows 11 (尤其 Insider 26200) WSL2 backend 的端口
#     bind 实际只在 127.0.0.1, LAN IP 上 Windows TCP 栈没有 listener;
#     netsh portproxy + 防火墙开放后 PC 自己用 LAN IP 都 timeout (实测).
#   - adb reverse 走 USB 通道, 跟网络 / WiFi / 防火墙完全无关, 真机/模拟器都行.
#   - 缺点: USB 线拔了就断, 重新接上要重跑这脚本 (代价小).
#
# 用法:
#   .\infra\dev-adb-reverse.ps1                 # 默认 reverse 8088/8080/8081
#   .\infra\dev-adb-reverse.ps1 -Ports 8088     # 只 reverse 8088
#   .\infra\dev-adb-reverse.ps1 -Remove         # 清掉所有 reverse 映射
#
# 之后 Android App Pair 页 Backend URL 填:
#   http://127.0.0.1:8088
# (手机的 localhost 等于 PC 的 localhost, adb 帮你转)
param(
    [int[]]$Ports = @(8088, 8080, 8081),
    [switch]$Remove
)

# UTF-8 输出, 防中文在 GBK 控制台乱码
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

$ErrorActionPreference = "Stop"

# 1. 找 adb
$adb = $null
$cmd = Get-Command adb -ErrorAction SilentlyContinue
if ($cmd) { $adb = $cmd.Source }
if (-not $adb) {
    $candidates = @(
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe",
        "C:\Android\Sdk\platform-tools\adb.exe",
        "C:\Program Files\Android\Sdk\platform-tools\adb.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $adb = $c; break }
    }
}
if (-not $adb) {
    Write-Host "[ERR] 找不到 adb.exe" -ForegroundColor Red
    Write-Host "      装 Android Studio 自带 platform-tools, 或独立装 Android SDK Platform Tools:"
    Write-Host "      https://developer.android.com/tools/releases/platform-tools"
    exit 1
}
Write-Host "adb: $adb" -ForegroundColor DarkGray

# 2. 列设备 — 解析 `adb devices` 输出. 第一行是 "List of devices attached", 后续是
# "<serial>\t<state>" (state 一般是 device, 也可能 offline / unauthorized).
$rawDevices = & $adb devices
$devices = @()
foreach ($line in $rawDevices) {
    $line = "$line".Trim()
    if ($line -eq '' -or $line -like 'List of devices*' -or $line -like '*daemon*') { continue }
    # 拆 serial + state (TAB 或 空格分隔均接受)
    $parts = $line -split "\s+", 2
    if ($parts.Count -ne 2) { continue }
    $serial = $parts[0]
    $state = $parts[1]
    if ($state -eq 'device') {
        $devices += $serial
    } elseif ($state -eq 'unauthorized') {
        Write-Host "[WARN] 设备 $serial 未授权 - 在手机上点'允许此电脑调试'" -ForegroundColor Yellow
    } elseif ($state -eq 'offline') {
        Write-Host "[WARN] 设备 $serial 离线 - 重接 USB / adb kill-server 再试" -ForegroundColor Yellow
    }
}
if ($devices.Count -eq 0) {
    Write-Host "[ERR] 没检测到已连接 Android 设备" -ForegroundColor Red
    Write-Host "  - 真机: 开 USB 调试 + 接 USB 线, 第一次连接手机会弹授权确认"
    Write-Host "  - 模拟器: 启动 AVD"
    exit 1
}
Write-Host "检测到 $($devices.Count) 个设备: $($devices -join ', ')" -ForegroundColor Green
Write-Host ""

# 3. reverse / 删除
foreach ($d in $devices) {
    Write-Host "-- 设备: $d --" -ForegroundColor Cyan
    if ($Remove) {
        & $adb -s $d reverse --remove-all
        Write-Host "  已清空所有 reverse 映射"
    } else {
        foreach ($p in $Ports) {
            & $adb -s $d reverse "tcp:$p" "tcp:$p" | Out-Null
            Write-Host "  reverse tcp:$p -> 127.0.0.1:$p"
        }
    }
    Write-Host "  当前映射:"
    $list = & $adb -s $d reverse --list
    if ($list) {
        $list | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
        Write-Host "    (无)" -ForegroundColor DarkGray
    }
    Write-Host ""
}

if (-not $Remove) {
    Write-Host "[OK] Android NinoGame App Pair 页 Backend URL 填: " -ForegroundColor Green -NoNewline
    Write-Host "http://127.0.0.1:8088" -ForegroundColor Yellow
    Write-Host "    USB 线拔了映射会断, 重新接上要再跑一次本脚本."
}
