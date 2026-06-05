@echo off
REM Double-click to start listening: attaches the dongle, opens the tunnel,
REM and runs the decoder. Close the window (or Ctrl-C) to stop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-SafeT-SDR.ps1"
