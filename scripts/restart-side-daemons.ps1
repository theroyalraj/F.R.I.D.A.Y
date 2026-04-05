# Restart OpenClaw *auxiliary* Python daemons (email, reminders, Composer watcher, ambient, music).
# Does NOT stop skill-gateway, pc-agent, or friday-listen — use npm run restart:local for a full stack bounce.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/restart-side-daemons.ps1
#      or npm run restart:side

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

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
Write-Host "Stopping auxiliary Python processes..." -ForegroundColor Cyan

Stop-PythonDaemon 'gmail-watch'           '*gmail-watch*'
Stop-PythonDaemon 'friday-action-tracker' '*friday-action-tracker*'
Stop-PythonDaemon 'friday-reminder-watch' '*friday-reminder-watch*'
Stop-PythonDaemon 'cursor-reply-watch'    '*cursor-reply-watch*'
Stop-PythonDaemon 'cursor-thinking-ocr'   '*cursor-thinking-ocr*'
Stop-PythonDaemon 'friday-ambient'        '*friday-ambient*'
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

if (Get-DotEnvBool 'FRIDAY_CURSOR_THINKING_OCR' $false) {
  Write-Host "Starting cursor-thinking-ocr..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/cursor-thinking-ocr.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping cursor-thinking-ocr (FRIDAY_CURSOR_THINKING_OCR not on)" -ForegroundColor DarkGray
}

if (Get-DotEnvBool 'FRIDAY_AMBIENT' $false) {
  Write-Host "Starting friday-ambient..." -ForegroundColor Green
  Start-Process $py -ArgumentList @('scripts/friday-ambient.py') -WorkingDirectory $root -WindowStyle Hidden
}
else {
  Write-Host "Skipping friday-ambient (FRIDAY_AMBIENT not on)" -ForegroundColor DarkGray
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
