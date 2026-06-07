@echo off
setlocal
title Build SafeT SDR

echo ============================================
echo   Building the SafeT SDR app (one time)
echo   First run downloads Electron - a few minutes.
echo ============================================
echo.

for /f "delims=" %%u in ('wsl -d Ubuntu -- bash -lc "echo $USER"') do set "WUSER=%%u"

echo [1/3] Installing build tools in Ubuntu...
wsl -d Ubuntu -u root -- bash -lc "command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1 || (apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y wine64 || DEBIAN_FRONTEND=noninteractive apt-get install -y wine)"

echo [2/3] Installing app dependencies...
wsl -d Ubuntu -- bash -lc "cd ~/safeT-PTT/sdr-bridge/desktop && npm install"

echo [3/3] Building the installer...
wsl -d Ubuntu -- bash -lc "cd ~/safeT-PTT/sdr-bridge/desktop && npm run dist"

echo.
echo Done. Opening the output folder - run 'SafeT SDR Setup ...exe' to install.
explorer.exe "\\wsl.localhost\Ubuntu\home\%WUSER%\safeT-PTT\sdr-bridge\desktop\dist"
echo.
pause
