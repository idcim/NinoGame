@echo off
REM ──────────────────────────────────────────────────────────────
REM 注册 Agent + Watchdog 为 Windows Service (需要管理员权限)
REM
REM 先决条件：
REM   1) 已运行 pyinstaller_build.bat 生成 dist\*.exe
REM   2) 已下载 NSSM (https://nssm.cc) 并放在 PATH 里
REM   3) 把 dist\* 复制到 C:\Program Files\NinoGame\
REM
REM ⚠ 重要：Agent 需要交互会话才能枚举窗口标题 / 监听键鼠 / 弹窗。
REM    NSSM 默认以 LocalSystem 启动，要么改成"以当前用户登录"，
REM    要么把 Agent 改为 child_primary 桌面自启动 + Watchdog 才做 Service。
REM ──────────────────────────────────────────────────────────────
setlocal

set INSTALL_DIR=C:\Program Files\NinoGame
set AGENT=%INSTALL_DIR%\NinoGameAgent.exe
set WATCHDOG=%INSTALL_DIR%\Watchdog.exe

if not exist "%AGENT%" (
    echo [install] %AGENT% missing. Build first.
    exit /b 1
)
if not exist "%WATCHDOG%" (
    echo [install] %WATCHDOG% missing. Build first.
    exit /b 1
)

nssm install NinoGameMonitorSvc "%AGENT%"
nssm set NinoGameMonitorSvc Start SERVICE_AUTO_START
nssm set NinoGameMonitorSvc AppRestartDelay 5000
nssm set NinoGameMonitorSvc AppExit Default Restart
nssm set NinoGameMonitorSvc Description "NinoGame Agent: process monitor + token economy"

nssm install NinoGameWatchdogSvc "%WATCHDOG%"
nssm set NinoGameWatchdogSvc Start SERVICE_AUTO_START
nssm set NinoGameWatchdogSvc AppRestartDelay 5000
nssm set NinoGameWatchdogSvc AppExit Default Restart
nssm set NinoGameWatchdogSvc Description "NinoGame Watchdog: keeps Agent alive"

echo [install] services registered. Start with:
echo   nssm start NinoGameMonitorSvc
echo   nssm start NinoGameWatchdogSvc
exit /b 0
