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

function Find-Busid {
  $list = usbipd list 2>$null
  # Prefer an exact Realtek RTL2832/2838 hardware-id match.
  foreach ($line in $list) {
    if ($line -match '^\s*(\d+-\d+)\s+0bda:283[28]') { return $matches[1] }
  }
  # Fall back to a name match for odd re-brands.
  foreach ($line in $list) {
    if ($line -match '^\s*(\d+-\d+)\s' -and ($line -match 'RTL283|RTL-SDR|NESDR|Bulk-In, Interface')) {
      return $matches[1]
    }
  }
  return $null
}

if (-not (Get-Command usbipd -ErrorAction SilentlyContinue)) {
  Write-Result "ERROR usbipd-not-installed"
  exit 3
}

$busid = Find-Busid
if (-not $busid) {
  Write-Result "ERROR no-device"
  exit 2
}

if ($Action -eq "detach") {
  & usbipd detach --busid $busid 2>$null
  Write-Result "DETACHED $busid"
  exit 0
}

# attach
& usbipd bind --busid $busid 2>$null    # harmless if already bound / shared
& usbipd attach --wsl --busid $busid 2>&1 | Out-Null
$ok = ($LASTEXITCODE -eq 0)
if (-not $ok) {
  # Older usbipd syntax.
  & usbipd wsl attach --busid $busid 2>&1 | Out-Null
  $ok = ($LASTEXITCODE -eq 0)
}

if ($ok) {
  Write-Result "ATTACHED $busid"
  exit 0
} else {
  # Most common cause on this hardware: two devices share one bus id, which makes
  # usbipd throw. Moving the dongle to a different USB port gives it its own id.
  Write-Result "ERROR attach-failed $busid (try a different USB port)"
  exit 1
}
