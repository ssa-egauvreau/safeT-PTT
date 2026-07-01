# install-sdrtrunk-restart-task.ps1
# Registers the Windows Task Scheduler job that runs restart-sdrtrunk.ps1 every
# 4 hours at highest privileges, working around SDRTrunk v0.6.1's slow heap leak
# (the watchdog relaunches SDRTrunk fresh after each kill — see SDRTRUNK.md).
#
# restart-sdrtrunk.ps1 is expected to live on the Desktop (the task points at
# %USERPROFILE%\Desktop\restart-sdrtrunk.ps1). Copy it there first if it isn't
# already, e.g.:
#   Copy-Item "$PSScriptRoot\restart-sdrtrunk.ps1" "$env:USERPROFILE\Desktop\restart-sdrtrunk.ps1" -Force
#
# Re-run any time to (re)create the task; /F overwrites an existing one.

schtasks /Create /TN "SDRTrunk Heap Restart" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\Desktop\restart-sdrtrunk.ps1\"" /SC HOURLY /MO 4 /RL HIGHEST /F
