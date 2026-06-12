@echo off
REM Double-click this to create a Nuskomate license key.
REM It just launches make-key.ps1 (bypassing PowerShell's script-block policy)
REM and keeps the window open so you can copy the key.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-key.ps1"
echo.
pause
