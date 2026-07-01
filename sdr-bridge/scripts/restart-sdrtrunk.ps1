# restart-sdrtrunk.ps1
# Kills ONLY the SDRTrunk java process. SafeT SDR's watchdog relaunches it fresh,
# resetting the Java heap (works around the v0.6.1 slow memory leak).
# Leaves Blue Iris, CodeProject.AI, and any other Java untouched.
$p = Get-Process -Name java -ErrorAction SilentlyContinue |
     Where-Object { $_.Path -and $_.Path -like '*sdr-trunk-windows*' }
if ($p) {
    $p | Stop-Process -Force
    "$(Get-Date -Format o)  killed SDRTrunk java (pid $($p.Id)) - watchdog will relaunch" |
        Out-File -Append "$env:USERPROFILE\Desktop\sdrtrunk-restart.log"
} else {
    "$(Get-Date -Format o)  no SDRTrunk java found (already restarting?)" |
        Out-File -Append "$env:USERPROFILE\Desktop\sdrtrunk-restart.log"
}
