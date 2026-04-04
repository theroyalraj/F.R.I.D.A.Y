<#
.SYNOPSIS
  Restart OpenClaw stack - kills old processes, handles Docker, then runs
  ALL services (gateway / agent / voice daemon) in THIS terminal window.
  Close / Ctrl+C the terminal and everything stops.

.PARAMETER SkipDocker
  Skip Docker steps; only free ports and start Node/Python services.

.PARAMETER NoKill
  Do not stop ffplay, friday-play, voice daemon, or free ports 3847/3848.
  If gateway + agent already respond on /health, exits without starting anything.
  Otherwise starts via start.mjs with OPENCLAW_NO_FREE_PORTS so existing listeners are not killed.

.EXAMPLE
  pwsh -File scripts/restart-local.ps1
  pwsh -File scripts/restart-local.ps1 -SkipDocker
  pwsh -File scripts/restart-local.ps1 -SkipDocker -NoKill
#>
param(
  [switch] $SkipDocker,
  [switch] $NoKill
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# -- 1. Kill anything on our ports (full restart only) -----------------------
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

if ($NoKill) {
  Write-Host "NoKill: skipping OpenClaw process kills and port frees." -ForegroundColor Cyan
} else {
  # -- 0. Stop any playing song / TTS ------------------------------------------
  $ffplayProcs = @(Get-Process -Name ffplay -ErrorAction SilentlyContinue)
  if ($ffplayProcs.Count -gt 0) {
    $ffplayProcs | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "  killed $($ffplayProcs.Count) ffplay process(es) (song/TTS stopped)"
  }

  # friday-speak uses a renamed ffplay executable on Windows
  $fridayPlayer = @(Get-Process -Name 'friday-player' -ErrorAction SilentlyContinue)
  if ($fridayPlayer.Count -gt 0) {
    $fridayPlayer | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "  killed $($fridayPlayer.Count) friday-player process(es) (Edge TTS playback)"
  }

  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*friday-play*' -or $_.CommandLine -like '*yt_dlp*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  killed play/download process (PID $($_.ProcessId))"
    }

  $pidFile = Join-Path $env:TEMP "friday-play.pid"
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }

  # Do not scan-kill all node processes matching server.js/start.mjs — that also hits
  # Docker Desktop, other IDEs, and unrelated apps. Local OpenClaw listeners are
  # stopped via the port free step below.

  Write-Host "Freeing ports 3848 and 3847..."
  Stop-ListenersOnPort @(3848, 3847)
  Start-Sleep -Milliseconds 600

  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*friday-listen*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  killed old voice daemon (PID $($_.ProcessId))"
    }

  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*friday-ambient*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  killed old ambient daemon (PID $($_.ProcessId))"
    }

  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*cursor-reply-watch*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  killed old cursor-reply watcher (PID $($_.ProcessId))"
    }

  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*friday-music-scheduler*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  killed old music scheduler (PID $($_.ProcessId))"
    }

  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*friday-speak*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "  killed stray TTS process (PID $($_.ProcessId))"
    }

  # Redis + temp files — stale friday:tts:lock or friday-tts-active can block all TTS after a crash
  $clearLocks = Join-Path $root 'skill-gateway\scripts\clear_friday_locks.py'
  if (Test-Path $clearLocks) {
    Write-Host 'Clearing Friday Redis locks + temp TTS files...'
    & python $clearLocks
  }
}

# -- 3. Docker (optional) ----------------------------------------------------
# Policy: never start, stop, or restart the Redis container from this script (no cache bounce,
# no n8n disconnect storm). Ensure Redis is up yourself: docker compose up -d redis
if ($SkipDocker) {
  Write-Host "Skipping Docker (-SkipDocker)."
}
else {
  Push-Location $root
  Write-Host "Docker: Redis container not touched by restart-local." -ForegroundColor DarkGray
  Write-Host "Docker: compose up -d n8n redis-insight ..."
  docker compose up -d n8n redis-insight
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "docker compose up -d n8n redis-insight failed (exit $LASTEXITCODE)."
  }
  Pop-Location
}

# -- 4. NoKill: if core HTTP services already healthy, skip spawn -------------
if ($NoKill -and (Test-OpenClawHealthy)) {
  Write-Host "OpenClaw already running (pc-agent + skill-gateway /health OK). Not starting another stack in this terminal." -ForegroundColor Green
  exit 0
}

if ($NoKill) {
  Write-Host "Core services not healthy - starting stack without freeing ports..." -ForegroundColor Yellow
}

# -- 5. Launch all services in THIS terminal via start.mjs -------------------
Write-Host ""
Write-Host "Starting services in this terminal (Ctrl+C stops everything)..." -ForegroundColor Yellow
Write-Host ""

Set-Location $root
if ($NoKill) {
  $env:OPENCLAW_NO_FREE_PORTS = '1'
} else {
  Remove-Item Env:\OPENCLAW_NO_FREE_PORTS -ErrorAction SilentlyContinue
}
node scripts/start.mjs
