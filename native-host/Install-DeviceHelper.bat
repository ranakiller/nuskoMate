@echo off
title Nuskomate Device Helper Setup

:: Re-launch this same file elevated (Administrator) if it isn't already —
:: "net session" only succeeds when the current process has admin rights, so
:: a nonzero error level here means it doesn't yet. Lets someone just
:: double-click this file instead of opening PowerShell and typing a command.
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo Requesting administrator permission...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
echo Press any key to close this window...
pause >nul
