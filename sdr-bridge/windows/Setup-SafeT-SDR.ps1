<#
  Setup-SafeT-SDR.ps1 — one-time setup (Windows 11). Run this once.

  Installs/configures everything the launcher needs:
    - WSL2 + Ubuntu (if missing)
    - usbipd-win (USB passthrough)
    - mirrored networking + systemd (so Docker auto-starts, no sudo prompts later)
    - inside Ubuntu: rtl-sdr, ffmpeg, icecast2, docker, nodejs, cloudflared
    - clones your safeT-PTT repo and seeds config/system.json
    - writes launcher.config.json for Start-SafeT-SDR.ps1

  If Ubuntu isn't installed yet, it installs it and asks you to reboot, create
  your Ubuntu username/password, then run this again to finish.

  Double-click "Setup SafeT SDR.cmd" to run.
#>
[CmdletBinding()]
param(
  [string]$Distro = "Ubuntu",
  [string]$RepoUrl = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
  Write-Host "Re-launching as Administrator..."
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$($MyInvocation.MyCommand.Path)`"")
  return
}

Write-Host "`n=== SafeT SDR one-time setup ===" -ForegroundColor Cyan

# --- WSL + Ubuntu ----------------------------------------------------------
$distroExists = $false
try {
  $distros = wsl -l -q 2>$null
  if ($distros -like "*$Distro*") {
    $distroExists = $true
  }
} catch {}

if (-not $distroExists) {
  Write-Host "`nInstalling WSL + $Distro..." -ForegroundColor Cyan
  wsl --install -d $Distro 2>&1 | % {
    if ($_ -match "already exists") {
      Write-Host "WSL distro '$Distro' already exists." -ForegroundColor Green
    } else {
      Write-Host $_
    }
  }
  Write-Host "`n*** Reboot if asked, open '$Distro' from the Start menu, create your" -ForegroundColor Yellow
  Write-Host "*** username/password, then run this Setup again to finish.`n" -ForegroundColor Yellow
  Read-Host "Press Enter to close"
  return
}
Write-Host "WSL distro '$Distro' is present." -ForegroundColor Green

# --- usbipd-win ------------------------------------------------------------
if (-not (Get-Command usbipd -ErrorAction SilentlyContinue)) {
  Write-Host "`nInstalling usbipd-win..." -ForegroundColor Cyan
  winget install --id usbipd-win --silent --accept-source-agreements --accept-package-agreements
} else {
  Write-Host "usbipd-win is installed." -ForegroundColor Green
}

# --- mirrored networking ---------------------------------------------------
$wslconfig = Join-Path $env:USERPROFILE ".wslconfig"
if (-not (Test-Path $wslconfig) -or -not (Select-String -Path $wslconfig -Pattern "networkingMode\s*=\s*mirrored" -Quiet)) {
  Write-Host "`nEnabling mirrored networking (.wslconfig)..." -ForegroundColor Cyan
  "[wsl2]`nnetworkingMode=mirrored" | Out-File -FilePath $wslconfig -Encoding ascii -Append
}

# --- prompt for repo URL ---------------------------------------------------
if (-not $RepoUrl) {
  $RepoUrl = Read-Host "`nYour safeT-PTT git URL (e.g. https://github.com/ssa-egauvreau/safeT-PTT.git)"
}

# --- provision inside Ubuntu (as root: no password prompts) ----------------
Write-Host "`nProvisioning inside $Distro (this can take a few minutes)..." -ForegroundColor Cyan
$provision = @'
set -e
echo "[wsl.conf] enabling systemd"
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
echo "[apt] installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y rtl-sdr ffmpeg icecast2 docker.io nodejs npm git usbutils curl ca-certificates
echo "[docker compose] installing plugin (docker.io alone doesn't include it)"
apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin || apt-get install -y docker-compose || true
echo "[cloudflared] installing"
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi
echo "[rtl-sdr] blacklisting kernel DVB driver"
printf 'blacklist dvb_usb_rtl28xxu\n' > /etc/modprobe.d/blacklist-rtl.conf
echo "[docker] enabling service + group"
usermod -aG docker "$(id -un 1000 2>/dev/null || echo ubuntu)" || true
systemctl enable docker >/dev/null 2>&1 || true
echo "provision-done"
'@
$provision = $provision -replace "`r`n", "`n"
wsl -d $Distro -u root -- bash -c $provision

# --- clone repo + seed config (as the normal user) -------------------------
$user = (wsl -d $Distro -- bash -lc 'echo $USER').Trim()
Write-Host "`nCloning repo + seeding config for user '$user'..." -ForegroundColor Cyan
$clone = @"
set -e
cd ~
if [ ! -d safeT-PTT ]; then git clone '$RepoUrl' safeT-PTT; fi
cd safeT-PTT/sdr-bridge
[ -f config/system.json ] || cp config/system.example.json config/system.json
echo "seeded config/system.json"
"@
$clone = $clone -replace "`r`n", "`n"
wsl -d $Distro -- bash -lc $clone

# --- save launcher settings ------------------------------------------------
@{ distro = $Distro; projectDir = "~/safeT-PTT/sdr-bridge"; repoUrl = $RepoUrl } |
  ConvertTo-Json | Out-File -FilePath (Join-Path $here "launcher.config.json") -Encoding ascii

# --- apply systemd / networking --------------------------------------------
Write-Host "`nRestarting WSL to apply systemd + networking..." -ForegroundColor Cyan
wsl --shutdown

# --- final instructions ----------------------------------------------------
$cfgWinPath = "\\wsl.localhost\$Distro\home\$user\safeT-PTT\sdr-bridge\config\system.json"
Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host @"

ONE more thing — edit your config (RF + passwords + SafeT login):
  $cfgWinPath

Fill in:  system.controlChannelsHz, icecast passwords, and safet.baseUrl/username/password.
(You do NOT list talkgroups here — you pick those in the SafeT console.)

Then:
  1. In the SafeT console: Bridges -> Import from RadioReference -> pick talkgroups -> Create
  2. Double-click "Start SafeT SDR.cmd"  (every time you want to listen)

"@ -ForegroundColor Cyan
$open = Read-Host "Open the config file now? (y/N)"
if ($open -match '^(y|Y)') { Start-Process notepad $cfgWinPath }
Read-Host "Press Enter to close"
