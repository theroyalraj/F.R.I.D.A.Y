<#
.SYNOPSIS
  Fire several friday-speak.py processes in quick succession (TTS burst / lock test).

.DESCRIPTION
  Serial spawn (default): each line waits for the previous friday-speak to exit, so you
  hear every line. friday-speak bumps a global generation before the playback lock; many
  parallel starts supersede each other and only the last line tends to play.

  Parallel spawn: stress test only — multiple processes at once; expect superseded skips.

  Queue mode uses cooperative TTS priority. Preempt uses priority one (cuts competing audio).

.PARAMETER Count
  How many speak processes to spawn (default 5).

.PARAMETER StaggerMs
  Sleep between Start-Process calls (default 0 = simultaneous spawn).

.PARAMETER Mode
  Queue = FRIDAY_TTS_PRIORITY cooperative. Preempt = priority one.

.PARAMETER Spawn
  Serial = wait for each speak to finish before starting the next (default).
  Parallel = fire all at once (generation supersede; mostly a lock stress test).

.EXAMPLE
  .\scripts\friday-speak-burst.ps1 -Count 5
  .\scripts\friday-speak-burst.ps1 -Count 3 -Mode Preempt -Spawn Parallel
#>
[CmdletBinding()]
param(
    [int][ValidateRange(1, 50)] $Count = 5,
    [int][ValidateRange(0, 5000)] $StaggerMs = 0,
    [ValidateSet('Queue', 'Preempt')] $Mode = 'Queue',
    [ValidateSet('Serial', 'Parallel')] $Spawn = 'Serial'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$speakPy = Join-Path $repoRoot 'skill-gateway\scripts\friday-speak.py'
if (-not (Test-Path -LiteralPath $speakPy)) {
    Write-Error "friday-speak.py not found at $speakPy"
}

$words = @(
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'
)
function Get-Word($n) {
    if ($n -ge 1 -and $n -le $words.Count) { return $words[$n - 1] }
    return [string]$n
}

$prio = if ($Mode -eq 'Preempt') { '1' } else { '2' }
$totalW = Get-Word $Count

$keys = @('FRIDAY_TTS_BYPASS_CURSOR_DEFER', 'FRIDAY_TTS_PRIORITY', 'FRIDAY_TTS_EMIT_EVENT')
$prev = @{}
foreach ($k in $keys) {
    $prev[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
}
$env:FRIDAY_TTS_BYPASS_CURSOR_DEFER = 'true'
$env:FRIDAY_TTS_PRIORITY = $prio
$env:FRIDAY_TTS_EMIT_EVENT = '0'

try {
    Write-Host "friday-speak-burst: count=$Count mode=$Mode spawn=$Spawn staggerMs=$StaggerMs"

    $wait = ($Spawn -eq 'Serial')
    for ($i = 1; $i -le $Count; $i++) {
        $iw = Get-Word $i
        $line = "Burst audio line $iw of $totalW."
        if ($wait) {
            $p = Start-Process -FilePath python -ArgumentList @($speakPy, $line) -WorkingDirectory $repoRoot -NoNewWindow -PassThru -Wait
            if ($p.ExitCode -ne 0) {
                Write-Warning "friday-speak exit code $($p.ExitCode) on line $i"
            }
        } else {
            Start-Process -FilePath python -ArgumentList @($speakPy, $line) -WorkingDirectory $repoRoot -NoNewWindow
        }
        if ($StaggerMs -gt 0) { Start-Sleep -Milliseconds $StaggerMs }
    }
}
finally {
    foreach ($k in $keys) {
        $v = $prev[$k]
        if ([string]::IsNullOrEmpty($v)) {
            Remove-Item "env:$k" -ErrorAction SilentlyContinue
        } else {
            Set-Item -Path "env:$k" -Value $v
        }
    }
}

if ($Spawn -eq 'Serial') {
    Write-Host 'Serial burst finished — you should have heard every line in order.'
} else {
    Write-Host 'Parallel spawn done — expect superseded lines; mostly a stress test.'
}
