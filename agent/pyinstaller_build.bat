@echo off
REM ──────────────────────────────────────────────────────────────
REM NinoGame Agent 打包脚本 (Windows)
REM
REM 输出 (onedir 模式, 启动瞬时, 不解压到 %TEMP%):
REM   dist\NinoGameAgent\
REM     ├── NinoGameAgent.exe   (~3MB 引导)
REM     ├── _internal\          (~120MB Qt + Python + 业务模块)
REM     ├── assets\             (logo / icon / tray 等)
REM     └── Watchdog.exe        (~7MB 单文件)
REM
REM 用法: 直接双击本脚本, 或在 cmd / PowerShell 跑。
REM       完成 / 报错都会停在 "按任意键继续" 等你看完输出。
REM ──────────────────────────────────────────────────────────────
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo  NinoGame Agent 打包
echo  cwd = %CD%
echo ============================================================
echo.

REM ── 0) 检查 python 在 PATH ────────────────────────────────────
where python >nul 2>nul
if errorlevel 1 (
    echo [error] python 不在 PATH 里。
    echo         请先装 Python 3.10+ 并把它加进 PATH; 或在 cmd 里
    echo         先跑 "conda activate" / "venv activate" 再跑本脚本。
    echo.
    goto :end
)
for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo [build] %%i

REM ── 1) venv (可选) ────────────────────────────────────────────
REM 如果 .venv 存在就用; 否则就直接用当前 Python (Anaconda / 系统 PY)
REM 这样不强制创 venv, 避免双 venv 路径混乱
if exist .venv\Scripts\python.exe (
    echo [build] using existing .venv
    call .venv\Scripts\activate.bat
) else (
    echo [build] no .venv found; using system Python
)
echo.

REM ── 2) deps ───────────────────────────────────────────────────
echo [build] installing requirements ...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo [error] pip install -r requirements.txt 失败
    goto :end
)
python -m pip install pyinstaller
if errorlevel 1 (
    echo [error] pip install pyinstaller 失败
    goto :end
)
echo.

REM ── 3) 清理旧产物 ─────────────────────────────────────────────
echo [build] cleaning old build/dist ...
if exist build rmdir /s /q build 2>nul
if exist dist  rmdir /s /q dist  2>nul
if exist NinoGameAgent.spec del /q NinoGameAgent.spec 2>nul
if exist Watchdog.spec       del /q Watchdog.spec     2>nul
echo.

REM ── 4) build Agent (onedir) ────────────────────────────────────
echo [build] building NinoGameAgent (onedir) ...
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
if errorlevel 1 (
    echo [error] 构建 NinoGameAgent 失败 (查上面输出)
    goto :end
)
echo.

REM ── 5) build Watchdog (onefile) ───────────────────────────────
echo [build] building Watchdog (onefile, into Agent folder) ...
pyinstaller ^
    --noconfirm ^
    --noconsole ^
    --onefile ^
    --name Watchdog ^
    --icon assets\icon.ico ^
    --paths . ^
    --collect-submodules protector ^
    --exclude-module numpy ^
    --distpath dist\NinoGameAgent ^
    watchdog_main.py
if errorlevel 1 (
    echo [error] 构建 Watchdog 失败
    goto :end
)
echo.

REM ── 6) 完成 ────────────────────────────────────────────────────
echo ============================================================
echo  [done] 输出:
echo    dist\NinoGameAgent\NinoGameAgent.exe   (启动入口)
echo    dist\NinoGameAgent\_internal\          (依赖)
echo    dist\NinoGameAgent\assets\             (图标)
echo    dist\NinoGameAgent\Watchdog.exe        (互守进程)
echo.
echo  安装: 把 dist\NinoGameAgent\ 整个文件夹拷到目标位置
echo        (例如 C:\Program Files\NinoGame\)
echo ============================================================

:end
echo.
echo (按任意键关闭此窗口)
pause >nul
endlocal
