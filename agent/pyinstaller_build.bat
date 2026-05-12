@echo off
REM ──────────────────────────────────────────────────────────────
REM NinoGame Agent 打包脚本 (Windows)
REM 输出：
REM   dist\NinoGameAgent.exe
REM   dist\Watchdog.exe
REM ──────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

if not exist .venv (
    echo [build] creating venv ...
    python -m venv .venv
)
call .venv\Scripts\activate.bat

echo [build] installing deps ...
pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller

echo [build] cleaning ...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo [build] building Agent ...
pyinstaller ^
    --noconsole ^
    --onefile ^
    --name NinoGameAgent ^
    --collect-submodules pynput ^
    --collect-submodules pystray ^
    main.py
if errorlevel 1 goto :fail

echo [build] building Watchdog ...
pyinstaller ^
    --noconsole ^
    --onefile ^
    --name Watchdog ^
    watchdog_main.py
if errorlevel 1 goto :fail

echo [build] copying schema.sql and seed configs ...
copy /Y store\schema.sql dist\schema.sql >nul

echo [build] done. Outputs:
echo   dist\NinoGameAgent.exe
echo   dist\Watchdog.exe
exit /b 0

:fail
echo [build] FAILED.
exit /b 1
