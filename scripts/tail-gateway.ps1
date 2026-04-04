# Follow JSON logs with pretty print (requires pino-pretty in path or npx).
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$f = Join-Path $root "logs\skill-gateway.log"
if (-not (Test-Path $f)) { Write-Error "Missing $f — set OPENCLAW_LOG_DIR=logs and restart gateway."; exit 1 }
Get-Content $f -Wait -Tail 80 | npx --yes pino-pretty
