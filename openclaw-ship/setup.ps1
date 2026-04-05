# Interactive setup: appends keys to repo-root .env if missing.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EnvFile = Join-Path $Root '.env'

Write-Host "OpenClaw ship setup — repo: $Root"
if (-not (Test-Path $EnvFile)) {
  Write-Host "No .env at $EnvFile — create one first."
  exit 1
}

function Append-Kv {
  param([string]$Key, [string]$Val)
  $content = Get-Content $EnvFile -Raw -ErrorAction SilentlyContinue
  if ($content -match "(?m)^$([regex]::Escape($Key))=") {
    Write-Host "  (keep existing) $Key"
  } else {
    Add-Content -Path $EnvFile -Value "$Key=$Val"
    Write-Host "  appended $Key"
  }
}

$or = Read-Host "OPENROUTER_API_KEY (empty to skip)"
if ($or) { Append-Kv 'OPENROUTER_API_KEY' $or }

$wh = Read-Host "N8N_WEBHOOK_SECRET (empty to skip)"
if ($wh) { Append-Kv 'N8N_WEBHOOK_SECRET' $wh }

$pa = Read-Host "PC_AGENT_SECRET (empty to skip)"
if ($pa) { Append-Kv 'PC_AGENT_SECRET' $pa }

Append-Kv 'OPENCLAW_ALEXA_ENABLED' 'false'
Append-Kv 'OPENCLAW_DIRECT_INTAKE' 'true'
Append-Kv 'OPENCLAW_START_MODE' 'all'

$pcu = Read-Host "PC_AGENT_URL for client-only machine (empty = default)"
if ($pcu) { Append-Kv 'PC_AGENT_URL' $pcu }

Write-Host ""
Write-Host "Done. Then: npm run start:server-stack | start:client-stack | start:all"
