<#
  Build-Exe.ps1 — turn the launcher into a real Windows .exe with the SafeT icon,
  and drop a "SafeT SDR" shortcut on your Desktop.

  Why a builder instead of a committed .exe? A prebuilt binary in the repo is
  opaque, antivirus-prone, and can't be code-reviewed. This compiles it locally
  in one double-click and is the standard PS2EXE approach.

  Double-click "Build EXE.cmd". Produces:  windows\SafeT SDR.exe  (+ Desktop shortcut)
  Run it once after Setup; re-run only if the launcher script changes.
#>
[CmdletBinding()]
param(
  [string]$OutFile = "SafeT SDR.exe"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$inFile = Join-Path $here "Start-SafeT-SDR.ps1"
$outPath = Join-Path $here $OutFile

if (-not (Test-Path $inFile)) { throw "Can't find Start-SafeT-SDR.ps1 next to this script." }

# Reuse the existing SafeT icon if it's in the repo (windows\ -> repo\desktop-console\build).
$iconPath = Join-Path $here "..\..\desktop-console\build\icon.ico"
$iconArg = @{}
if (Test-Path $iconPath) { $iconArg["iconFile"] = (Resolve-Path $iconPath).Path }

Write-Host "`n=== Building SafeT SDR.exe ===" -ForegroundColor Cyan

# --- ensure PS2EXE is available -------------------------------------------
if (-not (Get-Module -ListAvailable -Name ps2exe)) {
  Write-Host "Installing PS2EXE (one-time, from PowerShell Gallery)..." -ForegroundColor Cyan
  try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue } catch {}
  Install-Module -Name ps2exe -Scope CurrentUser -Force -AllowClobber
}
Import-Module ps2exe

# --- compile ---------------------------------------------------------------
# -requireAdmin: the exe requests elevation at launch (usbipd needs admin).
# Console stays visible so you see the live decoder log.
Invoke-ps2exe `
  -inputFile $inFile `
  -outputFile $outPath `
  -requireAdmin `
  -title "SafeT SDR" `
  -description "Start SafeT SDR — attach dongle, open tunnel, run the scanner bridge" `
  -company "Sunset Safety Agency" `
  -product "SafeT SDR" `
  -version "1.0.0" `
  @iconArg

if (-not (Test-Path $outPath)) { throw "Build failed — no exe produced." }
Write-Host "Built: $outPath" -ForegroundColor Green

# --- Desktop shortcut ------------------------------------------------------
try {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $lnk = Join-Path $desktop "SafeT SDR.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = $outPath
  $sc.WorkingDirectory = $here
  if ($iconArg.iconFile) { $sc.IconLocation = $iconArg.iconFile }
  $sc.Description = "Start SafeT SDR"
  $sc.Save()
  Write-Host "Desktop shortcut created: $lnk" -ForegroundColor Green
} catch {
  Write-Host "  ! Couldn't create the desktop shortcut ($($_.Exception.Message)). The exe still works." -ForegroundColor Yellow
}

Write-Host "`nDone. Double-click 'SafeT SDR' on your Desktop to start listening.`n" -ForegroundColor Cyan
Read-Host "Press Enter to close"
