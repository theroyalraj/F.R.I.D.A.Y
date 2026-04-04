<#
.SYNOPSIS
  Ensure OpenClaw pc-agent + skill-gateway are up before n8n morning workflows run.

.DESCRIPTION
  Docker n8n cannot start Node services on the Windows host when nothing is listening
  on 3847/3848. Schedule this script a few minutes before your nine AM n8n cron
  (e.g. Windows Task Scheduler at eight fifty five) so Gmail and WhatsApp steps work.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File scripts/morning-start-openclaw.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Test-OpenClawHealthy {
  try {
    $r1 = Invoke-WebRequest -Uri 'http://127.0.0.1:3847/health' -UseBasicParsing -TimeoutSec 3
    $r2 = Invoke-WebRequest -Uri 'http://127.0.0.1:3848/health' -UseBasicParsing -TimeoutSec 3
    return ($r1.StatusCode -lt 500 -and $r2.StatusCode -lt 500)
  } catch {
    return $false
  }
}

if (Test-OpenClawHealthy) {
  Write-Host 'OpenClaw already healthy — skipping start.'
  exit 0
}

Write-Host 'Starting OpenClaw in a minimised window (npm run start:all)...'
Start-Process -FilePath 'pwsh' -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  "Set-Location -LiteralPath '$root'; npm run start:all"
) -WorkingDirectory $root -WindowStyle Minimized
exit 0
