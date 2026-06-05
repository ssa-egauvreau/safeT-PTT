@echo off
REM Double-click to run one-time setup. Installs WSL/Ubuntu, tools, clones the repo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-SafeT-SDR.ps1"
