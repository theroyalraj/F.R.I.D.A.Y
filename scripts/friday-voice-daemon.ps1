<#
.SYNOPSIS
    One-click launcher for the Friday always-on voice daemon.

.DESCRIPTION
    Starts friday-listen.py in a visible terminal window so you can
    see transcriptions and speak commands to Friday at any time.
    The daemon listens, routes to pc-agent, and speaks back via edge-tts.

.USAGE
    From repo root:
        .\scripts\friday-voice-daemon.ps1

    Or add to Windows Task Scheduler / Startup to auto-run at login.

    To use a wake word (say "Friday, ..." to activate):
        $env:FRIDAY_LISTEN_WAKE = "friday"
        .\scripts\friday-voice-daemon.ps1

    To pick a specific mic:
        $env:LISTEN_DEVICE_INDEX = "1"
        .\scripts\friday-voice-daemon.ps1
#>

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

# Install deps if first run
$deps = @("SpeechRecognition", "pyaudio", "requests", "edge-tts", "sounddevice", "numpy")
foreach ($dep in $deps) {
    $check = python -c "import importlib; importlib.import_module('$( $dep.Replace('-','_').Replace('.','_') )')" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Installing $dep..." -ForegroundColor Cyan
        python -m pip install $dep --quiet
    }
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "  ║   F R I D A Y  —  Voice Daemon Starting         ║" -ForegroundColor White
Write-Host "  ║   Speak naturally · pc-agent must be running    ║" -ForegroundColor DarkGray
Write-Host "  ╚══════════════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

python scripts\friday-listen.py
