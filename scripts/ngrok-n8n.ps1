# Public HTTPS -> local N8N (port 5678). Use this URL in alexa-lambda-python/config.json as openclaw_intake_url:
#   https://<Forwarding-host>/webhook/friday-intake
# Run AFTER: ngrok config add-authtoken ...
Write-Host "Starting ngrok -> http://127.0.0.1:5678 (N8N — for Lambda / external webhooks)" -ForegroundColor Cyan
Write-Host "Copy the https://....ngrok-free.app prefix + /webhook/friday-intake into config.json" -ForegroundColor DarkGray
& ngrok http 5678 --log=stdout
