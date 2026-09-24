@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -NoBrowser
if errorlevel 1 (
  echo.
  echo The translation library could not start. Please keep this window open.
  echo The error details are shown above.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:4327/"
if errorlevel 1 "%SystemRoot%\explorer.exe" "http://127.0.0.1:4327/"
endlocal
