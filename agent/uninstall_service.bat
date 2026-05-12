@echo off
REM ============================================================
REM  Uninstall NinoGame services (needs admin)
REM ============================================================
setlocal

where nssm >nul 2>nul
if errorlevel 1 (
    echo [error] nssm not on PATH
    goto :end
)

nssm stop NinoGameMonitorSvc
nssm stop NinoGameWatchdogSvc
nssm remove NinoGameMonitorSvc confirm
nssm remove NinoGameWatchdogSvc confirm
echo [done] services removed

:end
echo.
echo (Press any key to close)
pause >nul
endlocal
