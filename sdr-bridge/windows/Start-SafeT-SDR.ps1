<#
  Start-SafeT-SDR.ps1 — one-click per-session launcher (Windows 11).

  Does the whole "every time" dance for you:
    1. self-elevates (usbipd needs admin)
    2. finds the Nooelec/RTL-SDR and attaches it to WSL
    3. (cloud SafeT) starts a cloudflared tunnel and grabs its live URL
    4. runs `npm start` inside WSL — which repoints your bridges to that URL,
       configures the decoder from the talkgroups you picked in the console, and
       launches Icecast + streamers + trunk-recorder
    5. on exit, stops the tunnel and detaches the dongle

  Daily use: just double-click "Start SafeT SDR.cmd". Run Setup once first.

  Overrides (optional):
    -Distro Ubuntu     WSL distro name
    -ProjectDir "~/safeT-PTT/sdr-bridge"
    -Local             skip the tunnel (SafeT self-hosted on this PC)
    -Cloud             force the tunnel
#>
[CmdletBinding()]
param(
  [string]$Distro = "",
  [string]$ProjectDir = "",
  [switch]$Local,
  [switch]$Cloud
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- self-elevate (usbipd attach requires admin) ---------------------------
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
  Write-Host "Re-launching as Administrator..."
  $argList = @("-NoProfile","-ExecutionPolicy","Bypass","-File","`"$($MyInvocation.MyCommand.Path)`"")
  if ($Distro)     { $argList += @("-Distro",$Distro) }
  if ($ProjectDir) { $argList += @("-ProjectDir","`"$ProjectDir`"") }
  if ($Local)      { $argList += "-Local" }
  if ($Cloud)      { $argList += "-Cloud" }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  return
}

# --- load saved settings from Setup, fill any gaps -------------------------
$cfgPath = Join-Path $here "launcher.config.json"
$saved = @{}
if (Test-Path $cfgPath) {
  try { $saved = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $saved = @{} }
}
if (-not $Distro)     { $Distro     = if ($saved.distro)     { $saved.distro }     else { "Ubuntu" } }
if (-not $ProjectDir) { $ProjectDir = if ($saved.projectDir) { $saved.projectDir } else { "~/safeT-PTT/sdr-bridge" } }

function Wsl([string]$cmd) { wsl -d $Distro -- bash -lc $cmd }

Write-Host ""
Write-Host "=== SafeT SDR launcher ===" -ForegroundColor Cyan
Write-Host "Distro: $Distro    Project: $ProjectDir"

# --- 1) attach the RTL-SDR dongle to WSL -----------------------------------
Write-Host "`n[1/3] Attaching the SDR dongle to WSL..." -ForegroundColor Cyan
$busid = $null
try {
  $list = usbipd list 2>$null
  foreach ($line in $list) {
    # Match a Realtek RTL2832/2838 (0bda:2832/2838) or anything that looks like an RTL-SDR.
    if ($line -match '^\s*(\d+-\d+)\s+(0bda:283[28])' -or
        ($line -match '^\s*(\d+-\d+)\s' -and $line -match 'RTL283|RTL-SDR|Bulk-In, Interface')) {
      $busid = $matches[1]; break
    }
  }
} catch { Write-Host "  (usbipd not found — run Setup first)" -ForegroundColor Yellow }

if ($busid) {
  Write-Host "  Found SDR at bus $busid"
  & usbipd bind --busid $busid 2>$null   # harmless if already bound
  & usbipd attach --wsl --busid $busid 2>$null
  if ($LASTEXITCODE -ne 0) { & usbipd wsl attach --busid $busid 2>$null } # older usbipd syntax
  Start-Sleep -Seconds 1
  if ((Wsl "lsusb | grep -qi 'RTL\|2838' && echo ok") -match "ok") {
    Write-Host "  Dongle is visible inside WSL." -ForegroundColor Green
  } else {
    Write-Host "  ! Dongle attach reported, but WSL can't see it yet. Continuing anyway." -ForegroundColor Yellow
  }
} else {
  Write-Host "  ! No RTL-SDR found via usbipd. Plug it in / re-run. Continuing (decoder will wait)." -ForegroundColor Yellow
}

# --- 2) decide cloud vs local, start tunnel if needed ----------------------
# Default is cloud (tunnel). Pass -Local for SafeT self-hosted on this PC, or set
# "mode":"local" in launcher.config.json.
$useTunnel = $true
if ($Local) { $useTunnel = $false }
elseif ($Cloud) { $useTunnel = $true }
elseif ($saved.mode -eq "local") { $useTunnel = $false }

$streamBase = "http://127.0.0.1:8000"
if ($useTunnel) {
  Write-Host "`n[2/3] Starting cloudflared tunnel (cloud SafeT)..." -ForegroundColor Cyan
  Wsl "pkill -f 'cloudflared tunnel --url' 2>/dev/null; rm -f /tmp/safet-cf.log; nohup cloudflared tunnel --url http://127.0.0.1:8000 >/tmp/safet-cf.log 2>&1 & echo started" | Out-Null
  $streamBase = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $u = Wsl "grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/safet-cf.log 2>/dev/null | head -1"
    if ($u) { $streamBase = $u.Trim(); break }
  }
  if (-not $streamBase) {
    Write-Host "  ! Couldn't get a tunnel URL. Is cloudflared installed in WSL? Run Setup." -ForegroundColor Yellow
    Write-Host "    Falling back to localhost (works only if SafeT is on this PC)." -ForegroundColor Yellow
    $streamBase = "http://127.0.0.1:8000"
  } else {
    Write-Host "  Tunnel: $streamBase" -ForegroundColor Green
  }
} else {
  Write-Host "`n[2/3] Self-hosted SafeT — no tunnel needed." -ForegroundColor Cyan
}

# --- 3) run the stack (foreground; Ctrl-C stops everything) ----------------
Write-Host "`n[3/3] Launching decoder + streams (Ctrl-C to stop)..." -ForegroundColor Cyan
Write-Host ""
try {
  wsl -d $Distro -- bash -lc "cd $ProjectDir && SDR_STREAM_BASE='$streamBase' npm start"
}
finally {
  Write-Host "`nShutting down..." -ForegroundColor Cyan
  if ($useTunnel) { Wsl "pkill -f 'cloudflared tunnel --url' 2>/dev/null; true" | Out-Null }
  if ($busid) { & usbipd detach --busid $busid 2>$null }
  Write-Host "Done. You can close this window."
}
