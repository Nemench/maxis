#Requires -RunAsAdministrator
<#
.SYNOPSIS
    MAXIS KOT — Windows Server Installer
.DESCRIPTION
    Installs MAXIS as a persistent Windows service using NSSM on Windows 10/11.
    Downloads and installs Node.js LTS and Git via winget if they are not present.
    Downloads NSSM automatically if not found at C:\nssm\nssm.exe.
    Re-running this script on an existing install is safe (pull + rebuild + service update).
.PARAMETER InstallDir
    Directory where the MAXIS repo will be cloned. Default: C:\opt\maxis
.PARAMETER Port
    HTTP port the server will listen on. Default: 3000
.PARAMETER ServiceName
    Name used to register the Windows service. Default: maxis
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Port 8080 -InstallDir D:\maxis
#>
[CmdletBinding()]
param(
    [string] $InstallDir  = "C:\opt\maxis",
    [int]    $Port        = 3000,
    [string] $ServiceName = "maxis"
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"   # suppresses slow Invoke-WebRequest progress bar

# ── Helpers ───────────────────────────────────────────────────────────────────
function Step  ([string]$msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function OK                   { Write-Host "   OK"     -ForegroundColor Green }
function Warn  ([string]$msg) { Write-Host "   WARN: $msg" -ForegroundColor Yellow }
function Abort ([string]$msg) { Write-Host "`nERROR: $msg`n" -ForegroundColor Red; exit 1 }

# Reload PATH from the registry so freshly-installed tools are visible
# in the current session without restarting PowerShell.
function Update-Path {
    $env:PATH = [Environment]::GetEnvironmentVariable("PATH", "Machine") +
                ";" +
                [Environment]::GetEnvironmentVariable("PATH", "User")
}

# ── 0. Winget availability ────────────────────────────────────────────────────
Step "Checking prerequisites..."
$hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
if (-not $hasWinget) {
    Warn "winget not found. If Node.js and Git are already installed, the script will continue."
    Warn "To enable automatic install of missing tools, install 'App Installer' from the Microsoft Store."
}

# ── 1. Node.js ────────────────────────────────────────────────────────────────
Step "Checking Node.js..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not $hasWinget) {
        Abort "Node.js not found and winget is unavailable. Install Node.js 20+ from https://nodejs.org/ then re-run."
    }
    Write-Host "   Installing Node.js LTS via winget..."
    winget install --id OpenJS.NodeJS.LTS --exact --scope machine --silent `
        --accept-source-agreements --accept-package-agreements
    Update-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Abort "Node.js still not found after install. Close this window, reopen as Administrator, and re-run."
    }
}
$nodeVersion = & node --version
Write-Host "   Node $nodeVersion at $((Get-Command node).Source)"

# ── 2. Git ────────────────────────────────────────────────────────────────────
Step "Checking Git..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not $hasWinget) {
        Abort "Git not found and winget is unavailable. Install Git from https://git-scm.com/ then re-run."
    }
    Write-Host "   Installing Git via winget..."
    winget install --id Git.Git --exact --scope machine --silent `
        --accept-source-agreements --accept-package-agreements
    Update-Path
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Abort "Git still not found after install. Close this window, reopen as Administrator, and re-run."
    }
}
Write-Host "   Git $((& git --version).Split(' ')[2]) at $((Get-Command git).Source)"

# ── 3. Clone or update repo ───────────────────────────────────────────────────
$RepoUrl = "https://github.com/Nemench/NemenchPos.git"
Step "Setting up repository at $InstallDir..."
if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "   Existing install found — pulling latest code..."
    & git -C $InstallDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Abort "git pull failed. Resolve any conflicts in $InstallDir and re-run." }
} else {
    if (Test-Path $InstallDir) {
        # Directory exists but no .git — clone into it only if empty
        $contents = Get-ChildItem $InstallDir -ErrorAction SilentlyContinue
        if ($contents) { Abort "$InstallDir exists and is not empty. Remove it or pick a different -InstallDir." }
    } else {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    Write-Host "   Cloning $RepoUrl..."
    & git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Abort "git clone failed." }
}
OK

# ── 4. npm ci + build ─────────────────────────────────────────────────────────
Push-Location $InstallDir
try {
    Step "Installing npm dependencies (npm ci)..."
    & npm ci --prefer-offline --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Abort "npm ci failed." }

    Step "Building production frontend (npm run build)..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { Abort "npm run build failed." }
    OK
} finally {
    Pop-Location
}

# Ensure data and logs directories exist
New-Item -ItemType Directory -Path (Join-Path $InstallDir "data") -Force | Out-Null
$LogDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# ── 5. NSSM ───────────────────────────────────────────────────────────────────
$NssmDir = "C:\nssm"
$NssmExe = Join-Path $NssmDir "nssm.exe"

Step "Checking NSSM (Non-Sucking Service Manager)..."
if (-not (Test-Path $NssmExe)) {
    Write-Host "   Downloading NSSM 2.24..."
    $zipPath    = Join-Path $env:TEMP "nssm-2.24.zip"
    $extractDir = Join-Path $env:TEMP "nssm-extract"

    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zipPath

    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
    New-Item -ItemType Directory -Path $NssmDir -Force | Out-Null
    Copy-Item (Join-Path $extractDir "nssm-2.24\$arch\nssm.exe") -Destination $NssmExe -Force

    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "   NSSM at $NssmExe"

# ── 6. Write a service launcher batch file ────────────────────────────────────
#
# We drive the service via a small .cmd wrapper rather than pointing NSSM
# directly at node.exe. This keeps all environment variables in one place
# and makes manual troubleshooting easy (just run start-maxis.cmd in a terminal).
#
Step "Writing service launcher..."
$NodeExe  = (Get-Command node).Source          # full path, e.g. C:\Program Files\nodejs\node.exe
$TsxCli   = Join-Path $InstallDir "node_modules\tsx\dist\cli.mjs"
$DataDir  = Join-Path $InstallDir "data"

if (-not (Test-Path $TsxCli)) {
    Abort "tsx not found at $TsxCli. Ensure npm ci completed successfully."
}

$StartCmd = Join-Path $InstallDir "start-maxis.cmd"
$batchContent = @"
@echo off
REM MAXIS KOT — service launcher (auto-generated by install.ps1)
set "NODE_ENV=production"
set "PORT=$Port"
set "DATA_DIR=$DataDir"
"$NodeExe" "$TsxCli" "$InstallDir\server\index.ts"
"@
Set-Content -Path $StartCmd -Value $batchContent -Encoding ASCII
Write-Host "   Launcher: $StartCmd"

# ── 7. Register / update the Windows service ──────────────────────────────────
Step "Registering '$ServiceName' Windows service..."

# Remove the existing service if present (idempotent re-install)
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Stopping and removing existing service..."
    & $NssmExe stop $ServiceName 2>$null
    Start-Sleep -Seconds 2
    & $NssmExe remove $ServiceName confirm
    Start-Sleep -Seconds 1
}

# Register: Application = cmd.exe, AppParameters = /c "start-maxis.cmd"
& $NssmExe install $ServiceName cmd.exe "/c `"$StartCmd`""
& $NssmExe set $ServiceName AppDirectory      $InstallDir
& $NssmExe set $ServiceName DisplayName       "MAXIS KOT"
& $NssmExe set $ServiceName Description       "MAXIS KOT kitchen order ticket server"
& $NssmExe set $ServiceName Start             SERVICE_AUTO_START
& $NssmExe set $ServiceName AppStdout         (Join-Path $LogDir "maxis.log")
& $NssmExe set $ServiceName AppStderr         (Join-Path $LogDir "maxis-error.log")
& $NssmExe set $ServiceName AppRotateFiles    1
& $NssmExe set $ServiceName AppRotateBytes    10485760   # rotate at 10 MB
& $NssmExe set $ServiceName AppRestartDelay   5000       # wait 5 s before restart on crash

Write-Host "   Starting service..."
& $NssmExe start $ServiceName
Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    OK
} else {
    Warn "Service status is '$($svc?.Status)'. Check logs in $LogDir for details."
    Write-Host "   You can also run: $NssmExe status $ServiceName"
}

# ── 8. Summary ────────────────────────────────────────────────────────────────
$LocalIP = (
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.PrefixOrigin -in @("Dhcp", "Manual") -and
        $_.InterfaceAlias -notmatch "Loopback|vEthernet"
    } |
    Select-Object -First 1 -ExpandProperty IPAddress
)
if (-not $LocalIP) { $LocalIP = "127.0.0.1" }

$border = "=" * 57
Write-Host ""
Write-Host $border                                              -ForegroundColor Green
Write-Host "  MAXIS KOT is running!"                           -ForegroundColor Green
Write-Host ""
Write-Host "  This PC:  http://localhost:$Port"                -ForegroundColor Green
Write-Host "  Network:  http://${LocalIP}:${Port}"             -ForegroundColor Green
Write-Host "  Login:    Admin / 0000  (change after first use)"-ForegroundColor Green
Write-Host $border                                              -ForegroundColor Green
Write-Host ""
Write-Host "  Service management:"
Write-Host "    $NssmExe status  $ServiceName"
Write-Host "    $NssmExe restart $ServiceName"
Write-Host "    $NssmExe stop    $ServiceName"
Write-Host ""
Write-Host "  Logs: $LogDir"
Write-Host "  Data: $DataDir"
Write-Host ""
Write-Host "  To update: powershell -ExecutionPolicy Bypass -File $InstallDir\update.ps1" -ForegroundColor Cyan
Write-Host ""
Write-Host "  PRINTING NOTE:" -ForegroundColor Yellow
Write-Host "  Server-side printing opens the default browser and calls window.print()." -ForegroundColor Yellow
Write-Host "  This requires the service to run in an interactive desktop session." -ForegroundColor Yellow
Write-Host "  If printing doesn't work, configure the service to log on as your" -ForegroundColor Yellow
Write-Host "  Windows user account via Services (services.msc) > MAXIS KOT > Log On." -ForegroundColor Yellow
Write-Host ""
