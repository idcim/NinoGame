@echo off
REM ============================================================
REM  NinoGame Agent build script (Windows)
REM
REM  Output (onedir mode, instant startup, no %TEMP% extraction):
REM    dist\NinoGameAgent\
REM      NinoGameAgent.exe   (entry, ~3 MB)
REM      _internal\          (deps, ~120 MB)
REM      assets\             (icons)
REM      Watchdog.exe        (peer process, ~7 MB)
REM
REM  Usage: just double-click. Window stays open on done/error.
REM  All output is English to avoid Chinese codepage issues
REM  (GBK vs UTF-8 on Chinese Windows mangles bat parsing).
REM ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo  NinoGame Agent build
echo  cwd = %CD%
echo ============================================================
echo.

REM ---- 0) check python ----
where python >nul 2>nul
if errorlevel 1 (
    echo [error] python not on PATH.
    echo         Install Python 3.10+ and add to PATH, OR run
    echo         "conda activate" / "venv activate" first.
    echo.
    goto :end
)
for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo [build] %%i

REM ---- 1) optional venv ----
if exist .venv\Scripts\python.exe (
    echo [build] using existing .venv
    call .venv\Scripts\activate.bat
) else (
    echo [build] no .venv, using system Python
)
echo.

REM ---- 2) deps ----
echo [build] installing requirements ...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo [error] pip install -r requirements.txt failed
    goto :end
)
python -m pip install pyinstaller
if errorlevel 1 (
    echo [error] pip install pyinstaller failed
    goto :end
)
echo.

REM ---- 3) clean old build/dist ----
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
    echo [error] NinoGameAgent build failed, see PyInstaller output above
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
    echo [error] Watchdog build failed
    goto :end
)
echo.

REM ---- 6) done ----
echo ============================================================
echo  [done] outputs:
echo    dist\NinoGameAgent\NinoGameAgent.exe   (entry)
echo    dist\NinoGameAgent\_internal\          (deps)
echo    dist\NinoGameAgent\assets\             (icons)
echo    dist\NinoGameAgent\Watchdog.exe        (peer)
echo.
echo  Install: copy the whole dist\NinoGameAgent\ folder to
echo           C:\Program Files\NinoGame\  (or wherever you want)
echo ============================================================

:end
echo.
echo (Press any key to close)
pause >nul
endlocal
