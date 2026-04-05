import { spawn } from 'node:child_process';
import process from 'node:process';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * Windows: open allowlisted apps via shell.
 * macOS: `open -a` / `open` for URLs and bundled apps.
 */
const ALIASES_WIN = {
  spotify: ['cmd', ['/c', 'start', '', 'spotify:']],
  browser: ['cmd', ['/c', 'start', '', 'https://']],
  edge: ['cmd', ['/c', 'start', '', 'msedge']],
  chrome: ['cmd', ['/c', 'start', '', 'chrome']],
  code: ['cmd', ['/c', 'start', '', 'code']],
  vscode: ['cmd', ['/c', 'start', '', 'code']],
  notepad: ['notepad', []],
  calculator: ['cmd', ['/c', 'start', '', 'calc']],
  calc: ['cmd', ['/c', 'start', '', 'calc']],
  explorer: ['explorer', []],
  terminal: ['wt', []],
  'windows terminal': ['wt', []],
};

/** @type {Record<string, { darwin: string[] }>} */
const ALIASES_MAC = {
  spotify: { darwin: ['open', ['-a', 'Spotify']] },
  browser: { darwin: ['open', ['https://']] },
  edge: { darwin: ['open', ['-a', 'Microsoft Edge']] },
  chrome: { darwin: ['open', ['-a', 'Google Chrome']] },
  code: { darwin: ['open', ['-a', 'Visual Studio Code']] },
  vscode: { darwin: ['open', ['-a', 'Visual Studio Code']] },
  notepad: { darwin: ['open', ['-a', 'TextEdit']] },
  calculator: { darwin: ['open', ['-a', 'Calculator']] },
  calc: { darwin: ['open', ['-a', 'Calculator']] },
  explorer: { darwin: ['open', ['.']] },
  terminal: { darwin: ['open', ['-a', 'Terminal']] },
  'windows terminal': { darwin: ['open', ['-a', 'Terminal']] },
};

function normalizeAppName(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/^open\s+/i, '')
    .trim();
  return t;
}

function stripLeadingArticle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .trim();
}

/**
 * Match allowlisted "open …" / "launch …" intents.
 */
export function matchOpenIntent(text) {
  const lower = String(text || '').toLowerCase();

  if (/^(open|launch)\s+/.test(lower)) {
    let rest = lower.replace(/^(open|launch)\s+/, '').trim();
    rest = stripLeadingArticle(rest);
    if (!rest) return null;
    const key = rest.split(/\s+/)[0];
    return key || null;
  }

  const mid = lower.match(/\bopen\s+(?:the\s+|a\s+|an\s+)?(\w+)\b/);
  if (mid) return mid[1];

  const launchMid = lower.match(/\blaunch\s+(?:the\s+|a\s+|an\s+)?(\w+)\b/);
  if (launchMid) return launchMid[1];

  return null;
}

function spawnOpen(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: isWin,
    });
    child.unref();
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    child.on('spawn', () => resolve({ ok: true, detail: `Started ${cmd} ${args.join(' ')}` }));
  });
}

export function openApp(appKey) {
  const key = normalizeAppName(appKey).split(/\s+/)[0];

  if (isMac) {
    const spec = ALIASES_MAC[key];
    if (!spec) {
      return Promise.resolve({
        ok: false,
        detail: `Unknown app "${key}". Allowlisted: ${Object.keys(ALIASES_MAC).join(', ')}`,
      });
    }
    return spawnOpen(spec.darwin[0], spec.darwin[1]);
  }

  const spec = ALIASES_WIN[key];
  if (!spec) {
    return Promise.resolve({
      ok: false,
      detail: `Unknown app "${key}". Allowlisted: ${Object.keys(ALIASES_WIN).join(', ')}`,
    });
  }
  const [cmd, args] = spec;
  return spawnOpen(cmd, args);
}
