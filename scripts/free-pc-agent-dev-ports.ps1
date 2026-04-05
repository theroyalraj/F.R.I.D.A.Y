<#
.SYNOPSIS
  Free TCP listen ports used by pc-agent full dev (Backend + Vite UI).

.DESCRIPTION
  Kills processes listening on the given ports so npm run dev:all does not hit EADDRINUSE.
  Uses the same taskkill tree pattern as scripts/restart-local.ps1 for node --watch children.

.PARAMETER Ports
  Ports to clear. Default: 3847 (PC_AGENT), 5173 (Vite ui:dev).

.EXAMPLE
  pwsh -File scripts/free-pc-agent-dev-ports.ps1
  pwsh -File scripts/free-pc-agent-dev-ports.ps1 -Ports 3847,5173,3848
#>
param(
  [int[]] $Ports = @()
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$agentPort = 3847
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) {
  Get-Content $envPath -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_ -match '^\s*PC_AGENT_PORT\s*=\s*(\d+)\s*$') {
      $agentPort = [int]$Matches[1]
    }
  }
}
if ($Ports.Count -eq 0) {
  $Ports = @($agentPort, 5173)
}

function Stop-ListenersOnPort {
  param([int[]] $PortList)
  foreach ($port in $PortList) {
    $ids = @(
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($id in $ids) {
      if ($id -and $id -gt 0) {
        $pp = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).ParentProcessId
        & taskkill /F /T /PID $id 2>$null | Out-Null
        Write-Host "  freed port $port - killed PID $id"
        if ($pp -and $pp -gt 4) {
          Stop-Process -Id $pp -Force -ErrorAction SilentlyContinue
          Write-Host "  freed port $port - killed parent PID $pp"
        }
      }
    }
  }
}

Write-Host "free-pc-agent-dev-ports: clearing $($Ports -join ', ')..." -ForegroundColor Yellow
Stop-ListenersOnPort -PortList $Ports
Start-Sleep -Milliseconds 400
Write-Host "done." -ForegroundColor DarkGray
