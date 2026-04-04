<#
.SYNOPSIS
  Restart OpenClaw stack — kills old processes, handles Docker, then runs
  ALL services (gateway · agent · voice daemon) in THIS terminal window.
  Close / Ctrl+C the terminal and everything stops.

.PARAMETER SkipDocker
  Skip Docker steps; only free ports and start Node/Python services.

.EXAMPLE
  pwsh -File scripts/restart-local.ps1
  pwsh -File scripts/restart-local.ps1 -SkipDocker
#>
param([switch] $SkipDocker)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# ── 1. Kill anything on our ports ────────────────────────────────────────────
function Stop-ListenersOnPort {
  param([int[]] $Ports)
  foreach ($port in $Ports) {
    $ids = @(
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($id in $ids) {
      if ($id -and $id -gt 0) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        Write-Host "  killed PID $id (port $port)"
      }
    }
  }
}

Write-Host ""
Write-Host "=== OpenClaw restart ===" -ForegroundColor Yellow

# ── 0. Stop any playing song / TTS ───────────────────────────────────────────
# Kill every ffplay instance (covers both friday-play.py songs and friday-speak.py TTS)
$ffplayProcs = @(Get-Process -Name ffplay -ErrorAction SilentlyContinue)
if ($ffplayProcs.Count -gt 0) {
  $ffplayProcs | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "  killed $($ffplayProcs.Count) ffplay process(es) (song/TTS stopped)"
}

# Kill friday-play.py Python process (may still be mid-download via yt-dlp)
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*friday-play*' -or $_.CommandLine -like '*yt_dlp*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "  killed play/download process (PID $($_.ProcessId))"
  }

# Remove stale PID file so friday-play.py starts clean
$pidFile = Join-Path $env:TEMP "friday-play.pid"
if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }

# ── Kill ALL openclaw node processes (incl. node --watch parents) ─────────────
# This prevents node --watch from fighting back after we free ports
Write-Host "Stopping any OpenClaw node watchers..."
Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
    if ($cmd -match 'server\.js|start\.mjs') {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
      Write-Host "  killed node watcher/server PID $($_.Id)"
    }
  } catch {}
}

Write-Host "Freeing ports 3848 and 3847..."
Stop-ListenersOnPort @(3848, 3847)

# Short pause so the OS fully releases TCP ports after kills
Start-Sleep -Milliseconds 600

# ── 2. Kill any lingering voice daemon ───────────────────────────────────────
Get-Process -Name python -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*friday-listen*' } |
  ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Write-Host "  killed old voice daemon (PID $($_.Id))"
  }

# ── 3. Docker (optional) ─────────────────────────────────────────────────────
if (-not $SkipDocker) {
  Push-Location $root
  Write-Host "Docker: compose up -d ..."
  docker compose up -d
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "docker compose up -d failed (exit $LASTEXITCODE)."
  } else {
    docker compose restart
  }
  Pop-Location
} else {
  Write-Host "Skipping Docker (-SkipDocker)."
}

# ── 4. Launch all services in THIS terminal via start.mjs ────────────────────
Write-Host ""
Write-Host "Starting services in this terminal (Ctrl+C stops everything)..." -ForegroundColor Yellow
Write-Host ""

Set-Location $root
node scripts/start.mjs
