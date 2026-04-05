$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Ui = Join-Path $Root 'extension-ui'

Write-Host '==> OpenClaw extension UI build'
Set-Location $Ui
if (-not (Test-Path package.json)) { throw "Missing package.json in $Ui" }
npm install
npm run build

Write-Host ""
Write-Host "Built: $Ui\dist"
Write-Host "  Chrome: Extensions -> Load unpacked -> dist\"
Write-Host ""

$zip = Join-Path $Root 'openclaw-friday-ui.zip'
if (Get-Command Compress-Archive -ErrorAction SilentlyContinue) {
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $Ui 'dist\*') -DestinationPath $zip
  Write-Host "Zipped: $zip"
}
