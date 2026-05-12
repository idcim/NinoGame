@echo off
REM 卸载 NinoGame services (需要管理员)
setlocal
nssm stop NinoGameMonitorSvc
nssm stop NinoGameWatchdogSvc
nssm remove NinoGameMonitorSvc confirm
nssm remove NinoGameWatchdogSvc confirm
exit /b 0
