# Two windows: skill-gateway + pc-agent with Node --watch (auto-reload on save).
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Start-Process pwsh -ArgumentList @(
  '-NoExit', '-NoProfile', '-Command',
  "Set-Location '$root\skill-gateway'; Write-Host 'skill-gateway (watch)'; npm run dev"
)
Start-Process pwsh -ArgumentList @(
  '-NoExit', '-NoProfile', '-Command',
  "Set-Location '$root\pc-agent'; Write-Host 'pc-agent (watch)'; npm run dev"
)
Write-Host "Started two terminals. Logs: console and optional OPENCLAW_LOG_DIR."
