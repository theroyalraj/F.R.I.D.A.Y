/**
 * Windows toast notification via PowerShell (no extra npm packages).
 * Works on Windows 10 / 11 using the Windows.UI.Notifications WinRT API.
 * Silently no-ops on non-Windows platforms.
 */
import { spawn } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

// Notification type → accent colour for the attribution line
const TYPE_LABELS = {
  task_done: 'Task Done',
  waiting:   'Needs Your Input',
  alert:     'Alert',
  reminder:  'Reminder',
  result:    'Result Ready',
  build:     'Build Done',
  message:   'Message',
};

/**
 * Show a Windows toast notification. Resolves immediately (fire-and-forget).
 *
 * @param {object} opts
 * @param {string}  opts.title    Bold heading line
 * @param {string}  opts.body     Second line (message preview)
 * @param {string}  [opts.type]   Notification type key (affects label)
 * @param {import('pino').Logger} [opts.log]
 */
export function sendWinToast({ title, body, type = 'message', log }) {
  if (!IS_WINDOWS) return;

  const safeTitle = String(title || 'Friday')
    .replace(/[`$"'\\]/g, ' ').slice(0, 80).trim();
  const safeBody  = String(body || '')
    .replace(/[`$"'\\]/g, ' ').replace(/\r?\n/g, ' ').slice(0, 200).trim();
  const label     = TYPE_LABELS[type] || 'Message';

  // Modern ToastGeneric XML — shows title + body + attribution in notification centre
  const toastXml = `
<toast activationType="protocol" launch="openclaw://last-result">
  <visual>
    <binding template="ToastGeneric">
      <text><![CDATA[${safeTitle}]]></text>
      <text><![CDATA[${safeBody}]]></text>
      <text placement="attribution"><![CDATA[Friday · ${label}]]></text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.IM"/>
</toast>`.trim();

  const ps = `
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null
$xml=New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@'
${toastXml}
'@)
$toast=New-Object Windows.UI.Notifications.ToastNotification($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenClaw.Friday').Show($toast)
`.trim();

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  child.unref();

  child.on('error', (e) => {
    log?.warn({ err: String(e.message) }, 'winToast spawn failed');
  });
}
