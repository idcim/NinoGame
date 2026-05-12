@echo off
chcp 65001 >nul
REM ==============================================================
REM  NinoGame Agent 打包脚本 (Windows)
REM
REM  输出 (onedir 模式, 启动瞬时, 不解压到 %TEMP%):
REM    dist\NinoGameAgent\
REM      NinoGameAgent.exe   (启动入口, 约 3 MB)
REM      _internal\          (依赖, 约 120 MB)
REM      assets\             (图标资源)
REM      Watchdog.exe        (互守进程, 约 7 MB)
REM
REM  用法: 双击本脚本; 跑完或报错都会停在 "按任意键关闭"
REM ==============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ==============================================================
echo  NinoGame Agent 打包
echo  cwd = %CD%
echo ==============================================================
echo.

REM ---- 0) 检查 python ----
where python >nul 2>nul
if errorlevel 1 (
    echo [error] python 不在 PATH 里。
    echo         需要 Python 3.10 或更高, 把 python.exe 所在目录加进 PATH;
    echo         或先在 cmd 里跑 conda activate / venv activate 再来。
    echo.
    goto :end
)
for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo [build] %%i

REM ---- 1) venv (可选) ----
if exist .venv\Scripts\python.exe (
    echo [build] using existing .venv
    call .venv\Scripts\activate.bat
) else (
    echo [build] no .venv found; using system Python
)
echo.

REM ---- 2) deps ----
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

REM ---- 3) 清理旧产物 ----
echo [build] cleaning old build/dist ...
if exist build rmdir /s /q build 2>nul
if exist dist  rmdir /s /q dist  2>nul
if exist NinoGameAgent.spec del /q NinoGameAgent.spec 2>nul
if exist Watchdog.spec       del /q Watchdog.spec     2>nul
echo.

REM ---- 4) build Agent (onedir) ----
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
    echo [error] 构建 NinoGameAgent 失败 ^(查上面输出^)
    goto :end
)
echo.

REM ---- 5) build Watchdog (onefile) ----
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

REM ---- 6) 完成 ----
echo ==============================================================
echo  [done] 输出:
echo    dist\NinoGameAgent\NinoGameAgent.exe   (启动入口)
echo    dist\NinoGameAgent\_internal\          (依赖)
echo    dist\NinoGameAgent\assets\             (图标)
echo    dist\NinoGameAgent\Watchdog.exe        (互守进程)
echo.
echo  安装: 把 dist\NinoGameAgent\ 整个文件夹拷到目标位置
echo        (例如 C:\Program Files\NinoGame\)
echo ==============================================================

:end
echo.
echo (按任意键关闭此窗口)
pause >nul
endlocal
