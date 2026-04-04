# Opens ngrok dashboard so you can sign in / copy your authtoken, then prints the exact command to run.
Write-Host ""
Write-Host "=== ngrok sign-in ===" -ForegroundColor Cyan
Write-Host "1. Sign in (or create a free account) in the browser that just opened."
Write-Host "2. Copy your Authtoken from: Your Authtoken"
Write-Host "3. Run (paste YOUR token):"
Write-Host ""
Write-Host "   ngrok config add-authtoken <PASTE_TOKEN_HERE>" -ForegroundColor Yellow
Write-Host ""
Write-Host "4. Start the tunnel to Openclaw skill-gateway:"
Write-Host "   ngrok http 3848" -ForegroundColor Green
Write-Host "   ...or:  powershell -File `"$PSScriptRoot\ngrok-tunnel.ps1`""
Write-Host ""

Start-Process "https://dashboard.ngrok.com/get-started/your-authtoken"
