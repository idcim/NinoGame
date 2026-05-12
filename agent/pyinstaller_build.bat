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
REM PySide6 不 collect-submodules; 让 PyInstaller 静态分析自动选我们 import 的部分
REM (只用 QtCore / QtGui / QtWidgets), 避免 QtQuick / QtWebEngine 等几百 MB
pyinstaller ^
    --noconsole ^
    --onefile ^
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

echo [build] building Watchdog ...
pyinstaller ^
    --noconsole ^
    --onefile ^
    --name Watchdog ^
    --icon assets\icon.ico ^
    --paths . ^
    --collect-submodules protector ^
    watchdog_main.py
if errorlevel 1 goto :fail

echo [build] done. Outputs:
echo   dist\NinoGameAgent.exe
echo   dist\Watchdog.exe
exit /b 0

:fail
echo [build] FAILED.
exit /b 1
