@echo off
REM ============================================================
REM  Register Agent + Watchdog as Windows Service (needs admin)
REM
REM  Prerequisites:
REM    1) pyinstaller_build.bat produced dist\NinoGameAgent\
REM    2) NSSM (https://nssm.cc) on PATH
REM    3) Copied dist\NinoGameAgent\ folder to C:\Program Files\NinoGame\
REM
REM  Final layout:
REM    C:\Program Files\NinoGame\NinoGameAgent.exe
REM    C:\Program Files\NinoGame\_internal\...
REM    C:\Program Files\NinoGame\assets\...
REM    C:\Program Files\NinoGame\Watchdog.exe
REM
REM  IMPORTANT: Agent needs an interactive session to enumerate
REM    window titles / listen to mouse+kbd / show popups.
REM    Set NSSM "Log on as" to your user account (not LocalSystem).
REM ============================================================
setlocal

set INSTALL_DIR=C:\Program Files\NinoGame
set AGENT=%INSTALL_DIR%\NinoGameAgent.exe
set WATCHDOG=%INSTALL_DIR%\Watchdog.exe

where nssm >nul 2>nul
if errorlevel 1 (
    echo [error] nssm not on PATH. Download from https://nssm.cc
    echo         and place nssm.exe in a folder on PATH (e.g. C:\Windows).
    goto :end
)

if not exist "%AGENT%" (
    echo [error] %AGENT% missing.
    echo         Run pyinstaller_build.bat first, then copy
    echo         dist\NinoGameAgent\ folder to %INSTALL_DIR%
    goto :end
)
if not exist "%WATCHDOG%" (
    echo [error] %WATCHDOG% missing.
    goto :end
)

echo [install] registering NinoGameMonitorSvc ...
nssm install NinoGameMonitorSvc "%AGENT%"
nssm set NinoGameMonitorSvc Start SERVICE_AUTO_START
nssm set NinoGameMonitorSvc AppRestartDelay 5000
nssm set NinoGameMonitorSvc AppExit Default Restart
nssm set NinoGameMonitorSvc Description "NinoGame Agent: process monitor + token economy"

echo [install] registering NinoGameWatchdogSvc ...
nssm install NinoGameWatchdogSvc "%WATCHDOG%"
nssm set NinoGameWatchdogSvc Start SERVICE_AUTO_START
nssm set NinoGameWatchdogSvc AppRestartDelay 5000
nssm set NinoGameWatchdogSvc AppExit Default Restart
nssm set NinoGameWatchdogSvc Description "NinoGame Watchdog: keeps Agent alive"

echo.
echo [install] services registered. start with:
echo   nssm start NinoGameMonitorSvc
echo   nssm start NinoGameWatchdogSvc
echo.
echo Remember to set each service's "Log on as" to your user account
echo in NSSM GUI; LocalSystem cannot see the desktop session, so
echo window-title matching / pynput / popups will all fail.

:end
echo.
echo (Press any key to close)
pause >nul
endlocal
