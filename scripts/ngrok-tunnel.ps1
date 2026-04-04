# Public HTTPS -> local skill-gateway (port 3848). Run AFTER: ngrok config add-authtoken ...
# Alexa endpoint = Forwarding https URL + /alexa  (e.g. https://abc123.ngrok-free.app/alexa)
$ErrorActionPreference = "Stop"
Write-Host "Starting ngrok -> http://127.0.0.1:3848 (skill-gateway)" -ForegroundColor Cyan
Write-Host "Tip: In Alexa console choose SSL = certificate from a trusted CA (ngrok uses public TLS)." -ForegroundColor DarkGray
& ngrok http 3848 --log=stdout
