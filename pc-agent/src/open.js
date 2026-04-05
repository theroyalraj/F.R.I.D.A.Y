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

/** First word of app name must be one of these (avoids "open pull" inside long @cursor prompts). */
const ALLOWED_APP_KEYS = new Set(Object.keys(ALIASES_WIN));

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
 * Match allowlisted "open …" / "launch …" intents only on the first line, at the start
 * (optional "please "). No mid-string match — phrases like "If an open pull request…"
 * in @cursor prompts must not resolve to open_app('pull').
 */
export function matchOpenIntent(text) {
  const firstLine = String(text || '')
    .split('\n')[0]
    .trim()
    .toLowerCase();
  if (!firstLine) return null;

  const lead = firstLine.match(/^(?:please\s+)?(open|launch)\s+(.+)$/i);
  if (!lead) return null;

  let rest = lead[2].trim();
  rest = stripLeadingArticle(rest);
  if (!rest) return null;

  const key = rest.split(/\s+/)[0];
  if (!key || !ALLOWED_APP_KEYS.has(key)) return null;
  return key;
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
