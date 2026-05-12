@echo off
REM ──────────────────────────────────────────────────────────────
REM 注册 Agent + Watchdog 为 Windows Service (需要管理员权限)
REM
REM 先决条件:
REM   1) 已运行 pyinstaller_build.bat 生成 dist\NinoGameAgent\
REM   2) 已下载 NSSM (https://nssm.cc) 并放在 PATH 里
REM   3) 把整个 dist\NinoGameAgent\ 文件夹复制到 C:\Program Files\NinoGame\
REM      最终目录:
REM        C:\Program Files\NinoGame\NinoGameAgent.exe
REM        C:\Program Files\NinoGame\_internal\...
REM        C:\Program Files\NinoGame\assets\...
REM        C:\Program Files\NinoGame\Watchdog.exe
REM
REM ⚠ 重要: Agent 需要交互会话才能枚举窗口标题 / 监听键鼠 / 弹窗。
REM    NSSM 默认以 LocalSystem 启动, 改成"以当前用户登录"
REM    (NSSM GUI: Log on 标签 → This account)。
REM ──────────────────────────────────────────────────────────────
setlocal

set INSTALL_DIR=C:\Program Files\NinoGame
set AGENT=%INSTALL_DIR%\NinoGameAgent.exe
set WATCHDOG=%INSTALL_DIR%\Watchdog.exe

if not exist "%AGENT%" (
    echo [install] %AGENT% 不存在。请先 pyinstaller_build.bat 然后把
    echo            dist\NinoGameAgent\ 整个文件夹拷到 %INSTALL_DIR%
    exit /b 1
)
if not exist "%WATCHDOG%" (
    echo [install] %WATCHDOG% 不存在.
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

echo.
echo [install] 服务已注册。启动:
echo   nssm start NinoGameMonitorSvc
echo   nssm start NinoGameWatchdogSvc
echo.
echo 别忘了把 NSSM GUI 里两个服务的"Log on as"改成当前用户,
echo 否则 LocalSystem 看不到桌面会话, 窗口标题匹配 / pynput / 弹窗都会失效。
exit /b 0
