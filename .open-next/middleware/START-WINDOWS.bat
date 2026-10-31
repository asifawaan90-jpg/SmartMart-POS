@echo off
setlocal
cd /d "%~dp0"
title SmartMart POS

set "APP_URL=http://smartmart.local"

:: Already running? Just open browser
powershell -Command "try { $r=Invoke-WebRequest '%APP_URL%/api/version' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  echo Already running! Opening...
  start "" "%APP_URL%"
  exit /b 0
)

:: Direct turbo dev - no checks
echo SmartMart starting FAST...
echo Server: %APP_URL%

:: Start server in background (turbo = 5x fast)
start "SmartMart Server" /min cmd /c "npm run dev -- --turbo"

:: Open browser after 3 sec, don't wait for ready
timeout /t 3 /nobreak >nul
start "" "%APP_URL%"

:: Keep checking in background and refresh
powershell -Command "Start-Sleep 2; Start-Process '%APP_URL%'" >nul 2>&1

echo Done! Browser khul gaya.
exit /b 0
