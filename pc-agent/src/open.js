import { spawn } from 'node:child_process';

/**
 * Windows: open allowlisted apps via shell. Returns { ok, detail }.
 */
const ALIASES = {
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

function normalizeAppName(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/^open\s+/i, '')
    .trim();
  return t;
}

export function matchOpenIntent(text) {
  const lower = String(text || '').toLowerCase();
  if (!/^(open|launch)\s+/.test(lower)) return null;
  const rest = lower.replace(/^(open|launch)\s+/, '').trim();
  if (!rest) return null;
  const key = rest.split(/\s+/)[0];
  return key;
}

export function openApp(appKey) {
  const key = normalizeAppName(appKey).split(/\s+/)[0];
  const spec = ALIASES[key];
  if (!spec) {
    return { ok: false, detail: `Unknown app "${key}". Allowlisted: ${Object.keys(ALIASES).join(', ')}` };
  }
  const [cmd, args] = spec;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    child.on('spawn', () => resolve({ ok: true, detail: `Started ${key}` }));
  });
}
