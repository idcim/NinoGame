@echo off
chcp 65001 >nul
REM ==============================================================
REM  卸载 NinoGame services (需要管理员)
REM ==============================================================
setlocal

where nssm >nul 2>nul
if errorlevel 1 (
    echo [error] nssm 不在 PATH 里
    goto :end
)

nssm stop NinoGameMonitorSvc
nssm stop NinoGameWatchdogSvc
nssm remove NinoGameMonitorSvc confirm
nssm remove NinoGameWatchdogSvc confirm
echo [done] 服务已卸载

:end
echo.
echo (按任意键关闭此窗口)
pause >nul
endlocal
