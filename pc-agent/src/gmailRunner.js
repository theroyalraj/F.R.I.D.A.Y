import { spawn } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Run scripts/gmail.py with args. Requires GMAIL_ADDRESS + GMAIL_APP_PWD in env.
 * @param {string[]} args
 * @returns {Promise<string>} stdout (JSON lines from script)
 */
export function runPythonGmail(args) {
  return new Promise((resolve, reject) => {
    const script = path.join(REPO_ROOT, 'scripts', 'gmail.py');
    const child = spawn('python', [script, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `gmail.py exited ${code}`));
      } else {
        resolve(out.trim());
      }
    });
  });
}

/**
 * @param {{
 *   unreadCount?: number,
 *   recentCount?: number,
 *   unreadOffset?: number,
 *   recentOffset?: number,
 * }} opts
 */
export async function fetchGmailSnapshot(opts = {}) {
  const unreadCount = Math.min(50, Math.max(1, Number(opts.unreadCount) || 15));
  const recentCount = Math.min(50, Math.max(1, Number(opts.recentCount) || 12));
  const unreadOffset = Math.min(500, Math.max(0, Number(opts.unreadOffset) || 0));
  const recentOffset = Math.min(500, Math.max(0, Number(opts.recentOffset) || 0));
  const unreadArgs = ['unread', '--count', String(unreadCount)];
  const recentArgs = ['list', '--count', String(recentCount)];
  if (unreadOffset > 0) unreadArgs.push('--offset', String(unreadOffset));
  if (recentOffset > 0) recentArgs.push('--offset', String(recentOffset));
  const [unreadJson, recentJson] = await Promise.all([
    runPythonGmail(unreadArgs),
    runPythonGmail(recentArgs),
  ]);
  return {
    ok: true,
    ts: new Date().toISOString(),
    unread: JSON.parse(unreadJson),
    recent: JSON.parse(recentJson),
  };
}
