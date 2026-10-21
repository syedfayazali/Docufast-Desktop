# DocuFast Shop Provisioning Script
# ----------------------------------
# Run this once on a new shop's PC (from the pendrive). It installs
# SumatraPDF, installs DocuFast Agent, and pre-fills the shop's key and
# printer path directly into the app's config — so the technician never has
# to click through the app's own setup wizard by hand.
#
# Folder layout expected next to this script:
#   install.bat                    <- technician double-clicks this
#   install.ps1                    <- this file
#   SumatraPDF-installer.exe       <- downloaded once from sumatrapdfreader.org
#   DocuFast Agent Setup X.X.X.exe <- the latest build you gave the shop

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg)       { Write-Host ""; Write-Host "ERROR: $msg" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "   DocuFast Agent — Shop Setup" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan

# ---- 1. Shop key ----
Write-Step "Shop details"
$shopKey = Read-Host "Paste this shop's API key (from the owner dashboard)"
if ([string]::IsNullOrWhiteSpace($shopKey)) { Fail "No key entered." }
$shopKey = $shopKey.Trim()

# ---- 2. Install SumatraPDF (skip if already present) ----
Write-Step "SumatraPDF"
$sumatraTargetDir = Join-Path $env:LOCALAPPDATA "SumatraPDF"
$sumatraExe = Join-Path $sumatraTargetDir "SumatraPDF.exe"

if (Test-Path $sumatraExe) {
    Write-Ok "Already installed at $sumatraExe"
} else {
    $sumatraInstaller = Join-Path $scriptDir "SumatraPDF-installer.exe"
    if (-not (Test-Path $sumatraInstaller)) {
        Fail "SumatraPDF-installer.exe not found next to this script.`nDownload the installer (not the portable zip) from https://www.sumatrapdfreader.org/download-free-pdf-viewer and put it in this folder, then run this script again."
    }
    Write-Host "    Installing silently..."
    Start-Process -FilePath $sumatraInstaller -ArgumentList @('-s', '-d', "`"$sumatraTargetDir`"") -Wait
    Start-Sleep -Seconds 2

    if (Test-Path $sumatraExe) {
        Write-Ok "Installed to $sumatraExe"
    } else {
        Write-Warn "Installer ran but SumatraPDF.exe wasn't found at the expected path — will search common locations next."
    }
}

# Search common install locations in case it landed somewhere else
# (e.g. a previous machine-wide install under Program Files).
$foundSumatra = $null
$candidates = @(
    $sumatraExe,
    (Join-Path $env:ProgramFiles "SumatraPDF\SumatraPDF.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "SumatraPDF\SumatraPDF.exe")
)
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $foundSumatra = $c; break }
}
if (-not $foundSumatra) {
    Write-Warn "Could not confirm SumatraPDF.exe anywhere — the shop's printer path will need fixing manually in Settings later."
    $foundSumatra = $sumatraExe  # best-guess fallback, still written to config
} else {
    Write-Ok "Using SumatraPDF at: $foundSumatra"
}

# ---- 3. Install DocuFast Agent (silent NSIS install) ----
Write-Step "DocuFast Agent"
$agentInstaller = Get-ChildItem -Path $scriptDir -Filter "DocuFast Agent Setup*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $agentInstaller) {
    Fail "No 'DocuFast Agent Setup*.exe' found next to this script. Copy the installer onto the pendrive next to install.bat."
}
Write-Host "    Installing $($agentInstaller.Name) silently..."
Start-Process -FilePath $agentInstaller.FullName -ArgumentList '/S' -Wait
Start-Sleep -Seconds 2

$agentExe = Join-Path $env:LOCALAPPDATA "Programs\DocuFast Agent\DocuFast Agent.exe"
if (Test-Path $agentExe) {
    Write-Ok "Installed to $agentExe"
} else {
    Fail "Install seemed to finish but the app wasn't found at the expected path. Open it from the Start Menu and check Settings manually — the config below was NOT written."
}

# ---- 4. Pre-fill the app's config so setup is skipped entirely ----
Write-Step "Writing shop configuration"

# Make sure the app has never run yet under this Windows user account —
# otherwise electron-store may have already created a config.json (e.g. a
# leftover default file) that this step needs to safely overwrite.
$configDir = Join-Path $env:APPDATA "DocuFast Agent"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$configPath = Join-Path $configDir "config.json"

$config = [ordered]@{
    agentKey    = $shopKey
    sumatraPath = $foundSumatra
    printerName = ""
    autoLaunch  = $true
    pollMs      = 10000
    setupDone   = $true
}
$config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
Write-Ok "Config written to $configPath"

# ---- 5. Launch the app ----
Write-Step "Starting DocuFast Agent"
Start-Process -FilePath $agentExe
Start-Sleep -Seconds 2
Write-Ok "Launched — check the system tray for the DocuFast icon."

Write-Host ""
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "   Setup complete for this shop!" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Double-check on the shop's PC:"
Write-Host "  1. Tray icon shows 'Connected' (double-click it to open the dashboard)"
Write-Host "  2. Dashboard shows the correct shop name"
Write-Host "  3. Print a test job from the shop's QR link"
Write-Host ""
Read-Host "Press Enter to close"
