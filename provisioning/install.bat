@echo off
REM DocuFast Shop Provisioning — double-click this file.
REM It just hands off to install.ps1, bypassing PowerShell's execution-policy
REM prompt for this one run only (doesn't change any system-wide setting).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Something went wrong — see the messages above.
  pause
)
