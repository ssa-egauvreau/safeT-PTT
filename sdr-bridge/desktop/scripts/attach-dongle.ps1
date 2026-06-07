<#
  attach-dongle.ps1 — attach/detach the RTL-SDR to WSL via usbipd.

  Run ELEVATED (the app launches it with "Start-Process -Verb RunAs"); usbipd
  attach/detach require Administrator. Finds the Nooelec/RTL-SDR by its hardware
  id (0bda:2838 / 0bda:2832) so it keeps working even when Windows reassigns the
  USB bus id after a reboot or replug.

  Writes a one-line result to $env:TEMP\safet-sdr-usbipd.txt so the app can read
  the outcome (an elevated process's console output isn't captured by the caller).

  Usage:  attach-dongle.ps1 -Action attach   |   -Action detach
#>
param(
  [ValidateSet("attach", "detach")] [string]$Action = "attach"
)

$ErrorActionPreference = "Continue"
$resultFile = Join-Path $env:TEMP "safet-sdr-usbipd.txt"

function Write-Result([string]$text) {
  Set-Content -Path $resultFile -Value $text -Encoding ascii
  Write-Output $text
}

function Find-Busids {
  # Return the bus id of EVERY RTL-SDR (supports multiple dongles).
  $ids = New-Object System.Collections.Generic.List[string]
  $list = usbipd list 2>$null
  foreach ($line in $list) {
    if ($line -match '^\s*(\d+-\d+)\s+0bda:283[28]') { $ids.Add($matches[1]) }
  }
  if ($ids.Count -eq 0) {
    foreach ($line in $list) {
      if ($line -match '^\s*(\d+-\d+)\s' -and ($line -match 'RTL283|RTL-SDR|NESDR|Bulk-In, Interface')) {
        $ids.Add($matches[1])
      }
    }
  }
  return ($ids | Select-Object -Unique)
}

if (-not (Get-Command usbipd -ErrorAction SilentlyContinue)) {
  Write-Result "ERROR usbipd-not-installed"
  exit 3
}

$busids = @(Find-Busids)
if ($busids.Count -eq 0) {
  Write-Result "ERROR no-device"
  exit 2
}

if ($Action -eq "detach") {
  foreach ($b in $busids) { & usbipd detach --busid $b 2>$null }
  Write-Result ("DETACHED " + ($busids -join ","))
  exit 0
}

# attach every RTL-SDR found
$attached = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]
foreach ($b in $busids) {
  & usbipd bind --busid $b 2>$null    # harmless if already bound / shared
  & usbipd attach --wsl --busid $b 2>&1 | Out-Null
  $ok = ($LASTEXITCODE -eq 0)
  if (-not $ok) { & usbipd wsl attach --busid $b 2>&1 | Out-Null; $ok = ($LASTEXITCODE -eq 0) }
  if ($ok) { $attached.Add($b) } else { $failed.Add($b) }
}

if ($attached.Count -gt 0 -and $failed.Count -eq 0) {
  Write-Result ("ATTACHED " + ($attached -join ","))
  exit 0
} elseif ($attached.Count -gt 0) {
  Write-Result ("PARTIAL attached " + ($attached -join ",") + " failed " + ($failed -join ","))
  exit 0
} else {
  # Most common cause: two USB devices share one bus id, which makes usbipd
  # throw. Moving the dongle to a different USB port gives it its own id.
  Write-Result ("ERROR attach-failed " + ($failed -join ",") + " (try a different USB port)")
  exit 1
}
