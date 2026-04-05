<#
.SYNOPSIS
  Start or refresh the OpenClaw stack in THIS terminal.

  **Default (safe):** does **not** kill pc-agent, skill-gateway, voice daemon, or listeners on
  3847/3848. If both services already respond on /health, exits. If ports are in use but
  unhealthy, exits with a message (no automatic kill).

.PARAMETER ForceKill
  **Explicit only:** POST skill-gateway /internal/stop-all-media?full=1 (kill players, clear TTS Redis),
  stop friday-speak and all voice-related Python daemons (listen, ambient, watchers, SAGE,
  gmail, tracker, reminders, Argus, music), free ports 3847/3848, clear locks again, then start.

.PARAMETER SkipDocker
  Skip Docker compose up for postgres / n8n / redis-insight.

.EXAMPLE
  pwsh -File scripts/restart-local.ps1
  pwsh -File scripts/restart-local.ps1 -SkipDocker
  pwsh -File scripts/restart-local.ps1 -ForceKill
  pwsh -File scripts/restart-local.ps1 -SkipDocker -ForceKill
#>
param(
  [switch] $SkipDocker,
  [switch] $ForceKill
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Test-PortListen {
  param([int] $Port)
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -ne $c
}

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

function Test-OpenClawHealthy {
  $ok3847 = $false
  $ok3848 = $false
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3847/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -lt 500) { $ok3847 = $true }
  } catch {}
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3848/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -lt 500) { $ok3848 = $true }
  } catch {}
  return ($ok3847 -and $ok3848)
}

Write-Host ""
Write-Host "=== OpenClaw restart ===" -ForegroundColor Yellow

function Stop-OpenClawPythonDaemon {
  param([string]$Label, [string]$Pattern)
  $hit = $false
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like $Pattern } |
    ForEach-Object {
      $hit = $true
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  stop $Label PID $($_.ProcessId)"
    }
  if (-not $hit) {
    Write-Host "  (no $Label)" -ForegroundColor DarkGray
  }
}

if ($ForceKill) {
  Write-Host "ForceKill: stop all media + TTS locks, release voice pipeline, free 3847/3848..." -ForegroundColor Magenta

  # While skill-gateway is still up: kill players, clear Redis TTS/music locks (full panic).
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:3848/internal/stop-all-media?full=1' -Method POST -TimeoutSec 4 -UseBasicParsing | Out-Null
    Write-Host "  gateway POST /internal/stop-all-media?full=1 (players + TTS locks)" -ForegroundColor DarkGray
  } catch {
    Write-Host "  gateway stop-all-media skipped (3848 not reachable)" -ForegroundColor DarkGray
  }

  # Any in-flight friday-speak / daemons that spawn TTS — before killing Node listeners.
  Stop-OpenClawPythonDaemon 'friday-speak' '*friday-speak*'
  Stop-OpenClawPythonDaemon 'gmail-watch' '*gmail-watch*'
  Stop-OpenClawPythonDaemon 'friday-action-tracker' '*friday-action-tracker*'
  Stop-OpenClawPythonDaemon 'friday-reminder-watch' '*friday-reminder-watch*'
  Stop-OpenClawPythonDaemon 'argus' '*argus.py*'
  Stop-OpenClawPythonDaemon 'friday-listen' '*friday-listen*'
  Stop-OpenClawPythonDaemon 'friday-ambient' '*friday-ambient*'
  Stop-OpenClawPythonDaemon 'cursor-reply-watch' '*cursor-reply-watch*'
  Stop-OpenClawPythonDaemon 'cursor-thinking-ocr' '*cursor-thinking-ocr*'
  Stop-OpenClawPythonDaemon 'friday-music-scheduler' '*friday-music-scheduler*'

  Start-Sleep -Milliseconds 400

  $ffplayProcs = @(Get-Process -Name ffplay -ErrorAction SilentlyContinue)
  if ($ffplayProcs.Count -gt 0) {
    $ffplayProcs | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "  killed $($ffplayProcs.Count) ffplay process(es)"
  }

  $fridayPlayer = @(Get-Process -Name 'friday-player' -ErrorAction SilentlyContinue)
  if ($fridayPlayer.Count -gt 0) {
    $fridayPlayer | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "  killed $($fridayPlayer.Count) friday-player process(es)"
  }

  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*friday-play*' -or $_.CommandLine -like '*yt_dlp*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  killed play/download PID $($_.ProcessId)"
    }

  $pidFile = Join-Path $env:TEMP "friday-play.pid"
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }

  Write-Host "Freeing ports 3848 and 3847..."
  Stop-ListenersOnPort @(3848, 3847)
  Start-Sleep -Milliseconds 600
}
else {
  Write-Host "Safe mode (default): no kills on 3847/3848 or OpenClaw Python daemons." -ForegroundColor Cyan
  Write-Host "Full replace: npm run restart:force   or   -ForceKill" -ForegroundColor DarkGray
  if (Test-OpenClawHealthy) {
    Write-Host "OpenClaw already running (pc-agent + skill-gateway /health OK). Not starting another stack in this terminal." -ForegroundColor Green
    exit 0
  }
  if ((Test-PortListen -Port 3847) -or (Test-PortListen -Port 3848)) {
    Write-Warning "Ports 3847 or 3848 are in use but /health did not pass."
    Write-Host "Stop those processes yourself, or run: npm run restart:force" -ForegroundColor Yellow
    exit 1
  }
}

$clearLocks = Join-Path $root 'skill-gateway\scripts\clear_friday_locks.py'
if (Test-Path $clearLocks) {
  Write-Host 'Clearing Friday Redis locks + temp TTS files...'
  & python $clearLocks
}

if ($SkipDocker) {
  Write-Host "Skipping Docker (-SkipDocker)."
}
else {
  Push-Location $root
  Write-Host "Docker: Redis container not touched by restart-local." -ForegroundColor DarkGray
  Write-Host "Docker: compose up -d openclaw-postgres n8n redis-insight ..."
  docker compose up -d openclaw-postgres n8n redis-insight
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "docker compose up -d openclaw-postgres n8n redis-insight failed (exit $LASTEXITCODE)."
  }
  Pop-Location
}

Write-Host ""
Write-Host "Starting services in this terminal (Ctrl+C stops everything)..." -ForegroundColor Yellow
Write-Host ""

Set-Location $root
Remove-Item Env:\OPENCLAW_NO_FREE_PORTS -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCLAW_FREE_PORTS_ON_START -ErrorAction SilentlyContinue

if ($ForceKill) {
  $env:OPENCLAW_FREE_PORTS_ON_START = '1'
}
else {
  $env:OPENCLAW_NO_FREE_PORTS = '1'
}

node scripts/start.mjs
