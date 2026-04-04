#!/usr/bin/env node
/**
 * Fire a task-done notification AND smoke-test the Edge TTS endpoint.
 *
 * Alexa beeps + yellow ring → say "Alexa, read my notifications"
 * → Alexa reads: "You have a message from <randomised Friday phrase>"
 *
 * TTS step: hits /voice/tts on pc-agent, plays the audio via PowerShell on Windows
 * (or just prints the byte count on other platforms).
 *
 * Overrides (all optional):
 *   NOTIFY_TEST_USER_ID    Alexa userId
 *   NOTIFY_TEST_MESSAGE    task result text (make it punchy — shown in notification + spoken)
 *   NOTIFY_TEST_LABEL      override creator name (bypasses phrase randomiser)
 *   NOTIFY_TEST_TYPE       notification type (default: task_done)
 *   GATEWAY_TEST_URL       override gateway base URL (default: http://127.0.0.1:3848)
 *   PC_AGENT_TEST_URL      override pc-agent base URL (default: http://127.0.0.1:3847)
 *   NOTIFY_TEST_NO_PROMPT  set "true" to skip the interactive prompt
 *   NOTIFY_TEST_SKIP_TTS   set "true" to skip the TTS smoke-test step
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const secret      = process.env.N8N_WEBHOOK_SECRET;
const gatewayPort = Number(process.env.PORT || 3848);
const agentPort   = Number(process.env.PC_AGENT_PORT || 3847);
const gatewayBase = (process.env.GATEWAY_TEST_URL  || `http://127.0.0.1:${gatewayPort}`).replace(/\/$/, '');
const agentBase   = (process.env.PC_AGENT_TEST_URL || `http://127.0.0.1:${agentPort}`).replace(/\/$/, '');

if (!secret) { console.error('Missing N8N_WEBHOOK_SECRET in .env'); process.exit(1); }

const gwHeaders = { 'Content-Type': 'application/json', 'X-Openclaw-Secret': secret };

const displayName = (process.env.FRIDAY_USER_NAME || 'Raj').trim() || 'Raj';
const taskMessage =
  process.env.NOTIFY_TEST_MESSAGE ||
  `Task Done ${displayName} — all good, ready for the next one.`;

// ── Step 1: Send Alexa notification ───────────────────────────────────────────
console.log('\n─── Alexa notification ─────────────────────────────────────────');
const body = {
  userId:        process.env.NOTIFY_TEST_USER_ID || 'amzn1.ask.account.LOCAL-TEST-NO-ALEXA-PING',
  message:       taskMessage,
  notify:        process.env.NOTIFY_TEST_SKIP !== 'true',
  notifyType:    process.env.NOTIFY_TEST_TYPE  || 'task_done',
  ...(process.env.NOTIFY_TEST_LABEL ? { notifyLabel: process.env.NOTIFY_TEST_LABEL } : {}),
  correlationId: crypto.randomUUID(),
};

const res  = await fetch(`${gatewayBase}/internal/last-result`, { method: 'POST', headers: gwHeaders, body: JSON.stringify(body) });
const json = await res.json().catch(() => ({}));

console.log(`POST /internal/last-result → HTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2));
if (!res.ok) process.exit(1);

const n = json?.notification;
if (n?.skipped === 'lwa_not_configured') {
  console.log('\n(Skipped — add ALEXA_LWA_CLIENT_ID / SECRET to .env)');
} else if (n?.ok) {
  console.log(`\n✓ Alexa notified — say "Alexa, read my notifications" to hear it.`);
} else if (n && !n.ok) {
  console.log(`\n⚠ ${n.error}: ${n.detail || ''}`);
}

// ── Step 2: Smoke-test Edge TTS ───────────────────────────────────────────────
if (process.env.NOTIFY_TEST_SKIP_TTS === 'true') {
  process.exit(0);
}

console.log('\n─── Edge TTS smoke test ────────────────────────────────────────');

// First check what provider is active
let ttsProvider = 'unknown';
let edgeVoice   = '';
try {
  const ping = await fetch(`${agentBase}/voice/ping`, {
    headers: { 'ngrok-skip-browser-warning': '1', Accept: 'application/json' },
  });
  if (ping.ok) {
    const pj = await ping.json();
    ttsProvider = pj?.tts?.provider || 'unknown';
    edgeVoice   = pj?.tts?.edgeVoice || '';
    console.log(`pc-agent TTS provider: ${ttsProvider}${edgeVoice ? ` (${edgeVoice})` : ''}`);
  }
} catch (e) {
  console.log(`(Could not reach pc-agent at ${agentBase} — is it running?)`);
  process.exit(0);
}

const speakText = taskMessage.length > 120 ? taskMessage.slice(0, 117) + '…' : taskMessage;

const ttsRes = await fetch(`${agentBase}/voice/tts`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
  body:    JSON.stringify({ text: speakText }),
  cache:   'no-store',
}).catch((e) => { console.error('TTS fetch failed:', e.message); process.exit(1); });

const ct = (ttsRes.headers.get('content-type') || '').toLowerCase();
const ttsHeader = ttsRes.headers.get('x-friday-tts') || '';
const voiceHeader = ttsRes.headers.get('x-friday-tts-voice') || '';

if (!ttsRes.ok) {
  const errBody = await ttsRes.text().catch(() => '');
  console.log(`POST /voice/tts → HTTP ${ttsRes.status} (${ct})`);
  console.log(errBody.slice(0, 300));
  process.exit(1);
}

const audioBytes = Buffer.from(await ttsRes.arrayBuffer());
console.log(`POST /voice/tts → HTTP ${ttsRes.status}  ${audioBytes.length} bytes  [${ttsHeader}${voiceHeader ? ` · ${voiceHeader}` : ''}]`);

const isAudio = ct.includes('audio/mpeg') || ct.includes('audio/wav');
if (!isAudio) {
  console.log(`⚠ Unexpected content-type: ${ct}`);
  process.exit(1);
}

console.log(`✓ Got audio (${(audioBytes.length / 1024).toFixed(1)} KB, ${ct})`);

// Play audio on Windows via PowerShell + Media.SoundPlayer / wmplayer
if (process.platform === 'win32') {
  const ext  = ct.includes('audio/mpeg') ? '.mp3' : '.wav';
  const tmp  = path.join(tmpdir(), `friday-tts-test-${crypto.randomUUID()}${ext}`);
  writeFileSync(tmp, audioBytes);

  console.log(`Playing via Windows Media Player (${tmp})…`);

  // Use wmplayer for MP3 (SoundPlayer is WAV-only)
  const ps = ext === '.mp3'
    ? `Add-Type -AssemblyName presentationCore; $mp=[System.Windows.Media.MediaPlayer]::new(); $mp.Open([Uri]::new('${tmp}')); $mp.Play(); Start-Sleep -Milliseconds 800; $dur=0; $sw=[Diagnostics.Stopwatch]::StartNew(); while($mp.NaturalDuration.HasTimeSpan -eq $false -and $sw.ElapsedMilliseconds -lt 3000){Start-Sleep -Milliseconds 100}; if($mp.NaturalDuration.HasTimeSpan){Start-Sleep -Seconds ($mp.NaturalDuration.TimeSpan.TotalSeconds + 0.5)}else{Start-Sleep -Seconds 5}; $mp.Close()`
    : `Add-Type -AssemblyName System.Windows.Forms; $p=New-Object System.Media.SoundPlayer('${tmp}'); $p.PlaySync()`;

  const tmpPs = path.join(tmpdir(), `friday-tts-play-${crypto.randomUUID()}.ps1`);
  writeFileSync(tmpPs, ps, 'utf8');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs],
    { stdio: 'inherit', windowsHide: false },
  );
  child.on('close', () => {
    try { unlinkSync(tmp); } catch {}
    try { unlinkSync(tmpPs); } catch {}
  });
  child.on('error', (e) => {
    console.error('Could not play audio:', e.message);
    try { unlinkSync(tmp); } catch {}
    try { unlinkSync(tmpPs); } catch {}
  });
} else {
  console.log(`(Non-Windows: audio not auto-played, but ${audioBytes.length} bytes received OK)`);
}
