# Test script: fire a Cursor-style "Done" toast and verify win-notify-watch picks it up.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\test_cursor_notify.ps1

param(
    [string]$Title = 'Done • Agent panel test',
    [string]$Body  = 'Open Cursor to view the agent output.'
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Helper to await WinRT async operations
$AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                   $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1

function Await($WinRtTask, $ResultType) {
    $asTaskGeneric = $AsTask.MakeGenericMethod($ResultType)
    $netTask = $asTaskGeneric.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

# Use Cursor's registered AppId (Electron uses exe path-based ID by default)
# Try both common formats; the one that works will emit a WPN entry
$appIds = @(
    'Cursor',
    'com.anysphere.cursor',
    'anysphere.cursor',
    'C:\Users\rajut\AppData\Local\Programs\cursor\Cursor.exe',
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
)

$xml = @"
<toast>
  <visual>
    <binding template="ToastText02">
      <text id="1">$Title</text>
      <text id="2">$Body</text>
    </binding>
  </visual>
  <audio silent="true"/>
</toast>
"@

$xdoc = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xdoc.LoadXml($xml)

# Try with PowerShell's own AppId (it IS registered, so toast will hit WPN DB)
# Then win-notify-watch will see it but it won't match "anysphere.cursor" — that's ok for UI test
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$toast    = [Windows.UI.Notifications.ToastNotification]::new($xdoc)
$notifier.Show($toast)

Write-Host "Toast fired via PowerShell AppId. win-notify-watch will see this as a generic app (not Cursor)."
Write-Host ""
Write-Host "To test Cursor detection, run a real agent task in Cursor — it fires its own toast on completion."
Write-Host ""
Write-Host "For a direct UI test (bypassing WPN), the SSE event was already POSTed to /voice/event."
Write-Host "Open the Listen UI and click the agent count button in the top bar to see the notification."
