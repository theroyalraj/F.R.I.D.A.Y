# Restart OpenClaw *auxiliary* Python daemons (email, reminders, Composer watcher, ambient, music).
# Does NOT stop skill-gateway, pc-agent, or friday-listen — use npm run restart:local for a full stack bounce.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/restart-side-daemons.ps1
#      or npm run restart:side

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Get-SageOcrFromDotEnv {
  $p = Join-Path $root '.env'
  if (-not (Test-Path $p)) { return $false }
  $rawSage = ''
  $rawOcr = ''
  foreach ($line in Get-Content -LiteralPath $p -Encoding utf8) {
    $t = $line.Trim()
    if ($t -match '^\s*#' -or $t -eq '') { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $v = $t.Substring($eq + 1).Split('#')[0].Trim().Trim('"').Trim("'").ToLowerInvariant()
    if ($k -eq 'FRIDAY_SAGE_ENABLED') { $rawSage = $v }
    if ($k -eq 'FRIDAY_CURSOR_THINKING_OCR') { $rawOcr = $v }
  }
  if (@('1', 'true', 'yes', 'on') -contains $rawSage) { return $true }
  if (@('0', 'false', 'no', 'off') -contains $rawSage) { return $false }
  return @('1', 'true', 'yes', 'on') -contains $rawOcr
}

function Get-DotEnvBool([string] $key, [bool] $default) {
  $p = Join-Path $root '.env'
  if (-not (Test-Path $p)) { return $default }
  foreach ($line in Get-Content -LiteralPath $p -Encoding utf8) {
    $t = $line.Trim()
    if ($t -match '^\s*#' -or $t -eq '') { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    if ($k -ne $key) { continue }
    $v = $t.Substring($eq + 1).Split('#')[0].Trim().Trim('"').Trim("'").ToLowerInvariant()
    if (@('0', 'false', 'no', 'off') -contains $v) { return $false }
    if (@('1', 'true', 'yes', 'on') -contains $v) { return $true }
    return $default
  }
  return $default
}

function Stop-PythonDaemon([string] $label, [string] $pattern) {
  $hit = $false
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like $pattern } |
    ForEach-Object {
      $hit = $true
      Write-Host "  stop $label PID $($_.ProcessId)" -ForegroundColor DarkYellow
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  if (-not $hit) {
    Write-Host "  (no $label)" -ForegroundColor DarkGray
  }
}

Write-Host ""
Write-Host "=== OpenClaw side daemons restart ===" -ForegroundColor Yellow

Write-Host "Gateway: stop-all-media (players + full TTS lock clear)..." -ForegroundColor Cyan
try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:3848/internal/stop-all-media?full=1' -Method POST -TimeoutSec 4 -UseBasicParsing | Out-Null
  Write-Host "  POST /internal/stop-all-media?full=1 ok" -ForegroundColor DarkGray
} catch {
  Write-Host "  (gateway not on 3848 — skipped)" -ForegroundColor DarkGray
}

Write-Host "Stopping auxiliary Python processes..." -ForegroundColor Cyan

Stop-PythonDaemon 'friday-speak'          '*friday-speak*'
Stop-PythonDaemon 'argus'                 '*argus.py*'
Stop-PythonDaemon 'gmail-watch'           '*gmail-watch*'
Stop-PythonDaemon 'friday-action-tracker' '*friday-action-tracker*'
Stop-PythonDaemon 'friday-reminder-watch' '*friday-reminder-watch*'
Stop-PythonDaemon 'cursor-reply-watch'    '*cursor-reply-watch*'
Stop-PythonDaemon 'sage (cursor-thinking-ocr)' '*cursor-thinking-ocr*'
Stop-PythonDaemon 'friday-ambient'        '*friday-ambient*'
Stop-PythonDaemon 'friday-silence-watch'  '*friday-silence-watch*'
Stop-PythonDaemon 'music-scheduler'       '*friday-music-scheduler*'

Start-Sleep -Milliseconds 600

$clearLocks = Join-Path $root 'skill-gateway\scripts\clear_friday_locks.py'
if (Test-Path $clearLocks) {
  Write-Host "Clearing Friday TTS locks..." -ForegroundColor Cyan
  & python $clearLocks
}

$py = 'python'
if (-not (Get-Command $py -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: python not on PATH" -ForegroundColor Red
  exit 1
}

if (Get-DotEnvBool 'FRIDAY_EMAIL_WATCH' $false) {
  Write-Host "Starting gmail-watch..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/gmail-watch.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping gmail-watch (FRIDAY_EMAIL_WATCH not on)" -ForegroundColor DarkGray
}

if (Get-DotEnvBool 'FRIDAY_TRACKER_ENABLED' $true) {
  Write-Host "Starting friday-action-tracker..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/friday-action-tracker.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping friday-action-tracker (FRIDAY_TRACKER_ENABLED off)" -ForegroundColor DarkGray
}

Write-Host "Starting friday-reminder-watch..." -ForegroundColor Green
Start-Process $py -ArgumentList @('scripts/friday-reminder-watch.py') -WorkingDirectory $root -WindowStyle Hidden

Write-Host "Starting cursor-reply-watch..." -ForegroundColor Green
Start-Process $py -ArgumentList @('scripts/cursor-reply-watch.py') -WorkingDirectory $root -WindowStyle Hidden

if (Get-SageOcrFromDotEnv) {
  Write-Host "Starting SAGE (cursor-thinking-ocr)..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/cursor-thinking-ocr.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping SAGE / cursor-thinking-ocr (FRIDAY_SAGE_ENABLED / FRIDAY_CURSOR_THINKING_OCR off)" -ForegroundColor DarkGray
}

if (Get-DotEnvBool 'FRIDAY_AMBIENT' $false) {
  Write-Host "Starting friday-ambient..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/friday-ambient.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping friday-ambient (FRIDAY_AMBIENT not on)" -ForegroundColor DarkGray
}

if (Get-DotEnvBool 'FRIDAY_SILENCE_WATCH' $true) {
  Write-Host "Starting friday-silence-watch (ECHO)..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/friday-silence-watch.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping friday-silence-watch (FRIDAY_SILENCE_WATCH off)" -ForegroundColor DarkGray
}

if (Get-DotEnvBool 'FRIDAY_MUSIC_SCHEDULER' $false) {
  Write-Host "Starting friday-music-scheduler..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/friday-music-scheduler.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping music scheduler (FRIDAY_MUSIC_SCHEDULER not on)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Side daemons restarted (gateway, pc-agent, friday-listen unchanged)." -ForegroundColor Green
Write-Host "If you also use npm run start:all in one terminal, its ambient/music child PIDs may have been replaced by these background processes." -ForegroundColor DarkGray
Write-Host ""
