# Example: enqueue "open notepad" through skill-gateway (same ngrok host as /alexa).
# Replace NGROK_HOST and SECRET. Do NOT post intake JSON to /alexa — use /openclaw/trigger.

$host = "https://YOUR-NGROK-SUBDOMAIN.ngrok-free.app"
$secret = "PASTE_N8N_WEBHOOK_SECRET_FROM_ENV"

$body = @{
    correlationId = [guid]::NewGuid().ToString()
    source          = "curl"
    userId          = "amzn1.ask.account.YOUR_ID"
    locale          = "en-US"
    commandText     = "open notepad"
    receivedAt      = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json

Invoke-RestMethod -Uri "$host/openclaw/trigger" -Method POST `
    -Headers @{
        "Content-Type"              = "application/json"
        "X-Openclaw-Secret"         = $secret
        "ngrok-skip-browser-warning" = "true"
    } `
    -Body $body
