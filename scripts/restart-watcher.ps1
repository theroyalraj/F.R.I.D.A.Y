# Restart cursor-reply-watch.py (the JSONL transcript watcher).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/restart-watcher.ps1
#   or:  npm run restart:watcher

Set-Location $PSScriptRoot\..

Write-Host "[restart-watcher] stopping existing watcher..." -ForegroundColor Yellow
Get-Process python -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like '*cursor-reply-watch*'
        } catch { $false }
    } |
    ForEach-Object {
        Write-Host "  killed PID $($_.Id)"
        Stop-Process -Id $_.Id -Force
    }

Start-Sleep -Milliseconds 500

Write-Host "[restart-watcher] starting cursor-reply-watch.py..." -ForegroundColor Green
Start-Process python -ArgumentList "scripts/cursor-reply-watch.py" `
    -WorkingDirectory (Get-Location).Path `
    -NoNewWindow

Start-Sleep -Seconds 2

$running = Get-Process python -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like '*cursor-reply-watch*'
        } catch { $false }
    }

if ($running) {
    Write-Host "[restart-watcher] watcher running (PID $($running.Id))" -ForegroundColor Green
} else {
    Write-Host "[restart-watcher] WARNING: watcher did not start" -ForegroundColor Red
}
