# restart-sdrtrunk.ps1
# Kills ONLY the SDRTrunk java process (matched by its *sdr-trunk-windows* path
# — Blue Iris, CodeProject.AI, and any other Java are left untouched), which
# resets the Java heap and works around the v0.6.1 slow memory leak.
#
# SafeT SDR's watchdog normally relaunches SDRTrunk within ~15s of the kill.
# But if the desktop app isn't running (closed, crashed, updating), a bare kill
# used to leave the whole feed dead until someone RDP'd in — so this script now
# BACKSTOPS the relaunch itself: it remembers where the killed SDRTrunk was
# installed, waits, and if no watchdog brought it back, starts bin\sdr-trunk.bat
# directly. Either way the outcome lands in Desktop\sdrtrunk-restart.log.
#
# -SdrtrunkRoot is optional: normally the install folder is derived from the
# killed process's own path. Pass it only if SDRTrunk wasn't running (nothing
# to derive from) and you still want the script able to start it.
param([string]$SdrtrunkRoot = "")

$logFile = "$env:USERPROFILE\Desktop\sdrtrunk-restart.log"
function Write-Log($msg) { "$(Get-Date -Format o)  $msg" | Out-File -Append $logFile }

$p = Get-Process -Name java -ErrorAction SilentlyContinue |
     Where-Object { $_.Path -and $_.Path -like '*sdr-trunk-windows*' }
if ($p) {
    # Derive the install root from the running java's path (walk up until a
    # folder containing bin\sdr-trunk.bat) so the backstop knows what to start.
    if (-not $SdrtrunkRoot) {
        $dir = Split-Path $p[0].Path
        while ($dir -and -not (Test-Path (Join-Path $dir 'bin\sdr-trunk.bat'))) { $dir = Split-Path $dir }
        if ($dir) { $SdrtrunkRoot = $dir }
    }
    $p | Stop-Process -Force
    Write-Log "killed SDRTrunk java (pid $($p.Id -join ',')) - waiting for relaunch"
} else {
    Write-Log "no SDRTrunk java found (already restarting?)"
}

# Backstop: give the SafeT SDR watchdog (15s poll) ample time, then relaunch
# ourselves if nothing did.
if ($SdrtrunkRoot) {
    Start-Sleep -Seconds 60
    $back = Get-Process -Name java -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path -like '*sdr-trunk-windows*' }
    if ($back) {
        Write-Log "watchdog relaunched SDRTrunk (pid $($back.Id -join ','))"
    } else {
        $bat = Join-Path $SdrtrunkRoot 'bin\sdr-trunk.bat'
        if (Test-Path $bat) {
            Start-Process -FilePath $bat -WorkingDirectory $SdrtrunkRoot -WindowStyle Minimized
            Write-Log "watchdog didn't relaunch - started $bat directly"
        } else {
            Write-Log "watchdog didn't relaunch and no bin\sdr-trunk.bat under $SdrtrunkRoot - start SDRTrunk manually"
        }
    }
} elseif ($p) {
    Write-Log "couldn't locate the SDRTrunk install folder from the killed process - relying on the watchdog"
}
