@echo off
REM ──────────────────────────────────────────────────────────────
REM NinoGame Agent 打包脚本 (Windows)
REM
REM 输出 (onedir 模式, 启动瞬时, 不解压到 %TEMP%):
REM   dist\NinoGameAgent\
REM     ├── NinoGameAgent.exe   (~1MB 引导)
REM     ├── _internal\          (~270MB Qt + Python + 业务模块)
REM     ├── assets\             (logo / icon / tray 等)
REM     └── Watchdog.exe        (~7MB 单文件)
REM
REM 安装: 把整个 dist\NinoGameAgent\ 文件夹复制到 C:\Program Files\NinoGame\
REM 或别的位置. 整个文件夹要原样保留, 不能只拷 .exe。
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

echo [build] building Agent (onedir mode) ...
pyinstaller ^
    --noconfirm ^
    --noconsole ^
    --name NinoGameAgent ^
    --icon assets\icon.ico ^
    --paths . ^
    --add-data "assets;assets" ^
    --add-data "store\schema.sql;store" ^
    --collect-submodules comms ^
    --collect-submodules core ^
    --collect-submodules store ^
    --collect-submodules ui ^
    --collect-submodules protector ^
    --collect-submodules pynput ^
    --collect-submodules pystray ^
    --collect-submodules qtawesome ^
    --collect-data qtawesome ^
    --exclude-module numpy ^
    --exclude-module scipy ^
    --exclude-module pandas ^
    --exclude-module matplotlib ^
    --exclude-module sklearn ^
    --exclude-module PySide6.QtQuick ^
    --exclude-module PySide6.QtQuick3D ^
    --exclude-module PySide6.QtQml ^
    --exclude-module PySide6.QtMultimedia ^
    --exclude-module PySide6.QtMultimediaWidgets ^
    --exclude-module PySide6.QtWebEngineCore ^
    --exclude-module PySide6.QtWebEngineWidgets ^
    --exclude-module PySide6.QtWebChannel ^
    --exclude-module PySide6.QtVirtualKeyboard ^
    --exclude-module PySide6.Qt3DCore ^
    --exclude-module PySide6.Qt3DRender ^
    --exclude-module PySide6.QtCharts ^
    --exclude-module PySide6.QtDataVisualization ^
    --exclude-module PySide6.QtPdf ^
    --exclude-module PySide6.QtPdfWidgets ^
    --exclude-module PySide6.QtSensors ^
    --exclude-module PySide6.QtSerialPort ^
    --exclude-module PySide6.QtPositioning ^
    --exclude-module PySide6.QtNetwork ^
    --exclude-module PySide6.QtSql ^
    --exclude-module PySide6.QtTest ^
    --exclude-module PySide6.QtBluetooth ^
    --exclude-module PySide6.QtNfc ^
    --exclude-module PySide6.QtRemoteObjects ^
    main.py
if errorlevel 1 goto :fail

echo [build] building Watchdog (onefile, only 7 MB) ...
REM Watchdog 不带 PySide6, 单文件没启动延迟也方便; 直接放到 Agent 目录里
pyinstaller ^
    --noconfirm ^
    --noconsole ^
    --onefile ^
    --name Watchdog ^
    --icon assets\icon.ico ^
    --paths . ^
    --collect-submodules protector ^
    --distpath dist\NinoGameAgent ^
    watchdog_main.py
if errorlevel 1 goto :fail

echo.
echo [build] done. Outputs:
echo   dist\NinoGameAgent\NinoGameAgent.exe  (启动入口)
echo   dist\NinoGameAgent\_internal\         (依赖)
echo   dist\NinoGameAgent\assets\            (图标)
echo   dist\NinoGameAgent\Watchdog.exe       (互守进程)
echo.
echo 安装: 把整个 dist\NinoGameAgent 文件夹拷到 C:\Program Files\NinoGame\
echo       然后 (管理员) 跑 install_service.bat
exit /b 0

:fail
echo [build] FAILED.
exit /b 1
