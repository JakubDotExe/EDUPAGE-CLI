@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    node app.js %*
) else (
    if exist ".venv\Scripts\python.exe" (
        ".venv\Scripts\python.exe" cli.py %*
    ) else (
        python cli.py %*
    )
)

if errorlevel 1 (
    echo.
    echo [!] Program skoncil s chybou.
    pause
)
