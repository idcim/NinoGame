@echo off
REM ============================================================
REM  NinoGame Agent build script (Windows)
REM
REM  Output (onedir mode, instant startup):
REM    dist\NinoGameAgent\
REM      NinoGameAgent.exe   (entry, ~3 MB)
REM      _internal\          (deps, ~120 MB)
REM      assets\             (icons)
REM      Watchdog.exe        (peer process, ~7 MB)
REM
REM  Usage: just double-click.
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
    goto :end
)
for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo [build] %%i
for /f "tokens=*" %%i in ('python -c "import sys; print(sys.executable)"') do echo [build] python = %%i

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
for /f "tokens=*" %%i in ('pyinstaller --version 2^>^&1') do echo [build] pyinstaller %%i
echo.

REM ---- 3) clean ALL old build/dist + caches ----
echo [build] cleaning old build/dist/spec ...
if exist build rmdir /s /q build 2>nul
if exist dist  rmdir /s /q dist  2>nul
if exist NinoGameAgent.spec del /q NinoGameAgent.spec 2>nul
if exist Watchdog.spec       del /q Watchdog.spec     2>nul
if exist __pycache__ rmdir /s /q __pycache__ 2>nul
for /d %%d in (*\__pycache__) do rmdir /s /q "%%d" 2>nul
echo.

REM ---- 4) build Agent (onedir, --clean forces fresh bootloader) ----
echo [build] building NinoGameAgent (onedir) ...
pyinstaller ^
    --noconfirm ^
    --clean ^
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
    --collect-submodules websocket ^
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
    echo [error] NinoGameAgent build failed
    goto :end
)
echo.

REM ---- 5) build Watchdog (onefile) ----
echo [build] building Watchdog ...
pyinstaller ^
    --noconfirm ^
    --clean ^
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

REM ---- 5.5) build Updater (onefile, 无 GUI 极小依赖) ----
echo [build] building Updater (v0.3.0+ 无感更新接管进程) ...
pyinstaller ^
    --noconfirm ^
    --clean ^
    --noconsole ^
    --onefile ^
    --name Updater ^
    --icon assets\icon.ico ^
    --paths . ^
    --exclude-module numpy ^
    --exclude-module PySide6 ^
    --exclude-module qtawesome ^
    --exclude-module PIL ^
    --exclude-module pystray ^
    --distpath dist\NinoGameAgent ^
    updater.py
if errorlevel 1 (
    echo [error] Updater build failed
    goto :end
)
echo.

REM ---- 6) sanity check: run the EXE briefly, see if it stays up ----
echo [build] sanity check: launching NinoGameAgent.exe for 6s ...
start "" /B dist\NinoGameAgent\NinoGameAgent.exe
timeout /t 6 /nobreak >nul
tasklist /FI "IMAGENAME eq NinoGameAgent.exe" 2>nul | find /I "NinoGameAgent.exe" >nul
if errorlevel 1 (
    echo.
    echo [WARN] NinoGameAgent.exe did NOT stay up. Possible causes:
    echo   - "Failed to start embedded python interpreter" popup
    echo     -^> Most common: PyInstaller bootloader broken or VCRedist missing.
    echo        Fix A: pip install --upgrade --force-reinstall pyinstaller
    echo        Fix B: Install "Microsoft Visual C++ 2015-2022 Redistributable x64"
    echo               https://aka.ms/vs/17/release/vc_redist.x64.exe
    echo        Fix C: Try CPython from python.org (not Anaconda)
    echo   - Run dist\NinoGameAgent\NinoGameAgent.exe manually and check
    echo     dist\NinoGameAgent\data\logs\agent.log
    echo.
) else (
    echo [build] OK, process is up. Killing test instance ...
    taskkill /F /IM NinoGameAgent.exe >nul 2>nul
    taskkill /F /IM Watchdog.exe >nul 2>nul
)
echo.

REM ---- 7) done ----
echo ============================================================
echo  [done] outputs:
echo    dist\NinoGameAgent\NinoGameAgent.exe   (entry)
echo    dist\NinoGameAgent\_internal\          (deps)
echo    dist\NinoGameAgent\assets\             (icons)
echo    dist\NinoGameAgent\Watchdog.exe        (peer)
echo    dist\NinoGameAgent\Updater.exe         (silent update, v0.3.0+)
echo.
echo  Install: copy dist\NinoGameAgent\ folder to your target
echo           (e.g. C:\Program Files\NinoGame\)
echo ============================================================

:end
echo.
echo (Press any key to close)
pause >nul
endlocal
