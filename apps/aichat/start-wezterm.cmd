@echo off
rem 双击即可：在 wezterm 新窗口里启动机器人，日志同时写入 logs\ 目录。
setlocal
cd /d "%~dp0"

where wezterm >nul 2>nul
if errorlevel 1 (
    echo 没找到 wezterm.exe，请把 WezTerm 加入 PATH，或改用: powershell -NoExit -File "%~dp0start.ps1"
    pause
    exit /b 1
)

wezterm start --cwd "%~dp0" -- pwsh -NoLogo -NoExit -File "%~dp0start.ps1"
