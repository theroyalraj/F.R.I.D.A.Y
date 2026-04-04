# Poll Openclaw local services (not Cursor / not "Open Jarvis").
# Usage: powershell -File scripts/openclaw-heartbeat.ps1 [-IntervalSec 15]
param([int]$IntervalSec = 15)

$ErrorActionPreference = "Continue"
Write-Host "Openclaw heartbeat — gateway :3848, pc-agent :3847 (Ctrl+C to stop)" -ForegroundColor Cyan

while ($true) {
  $ts = Get-Date -Format "HH:mm:ss"
  try {
    $g = Invoke-RestMethod "http://127.0.0.1:3848/health" -TimeoutSec 3
    Write-Host "[$ts] skill-gateway  OK  $($g.service)"
  } catch {
    Write-Host "[$ts] skill-gateway  FAIL  $($_.Exception.Message)" -ForegroundColor Red
  }
  try {
    $a = Invoke-RestMethod "http://127.0.0.1:3847/health" -TimeoutSec 3
    Write-Host "[$ts] pc-agent       OK  $($a.service)"
  } catch {
    Write-Host "[$ts] pc-agent       FAIL  $($_.Exception.Message)" -ForegroundColor Red
  }
  Start-Sleep -Seconds $IntervalSec
}
