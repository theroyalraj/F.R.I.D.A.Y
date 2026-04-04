import express from 'express';
import { spawn } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function runPythonGmail(args) {
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

export function createAutomationRouter(authMiddleware) {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  r.use(authMiddleware);

  /**
   * Runs scripts/gmail.py unread + list; returns JSON for n8n (Docker) automations.
   * Requires GMAIL_ADDRESS + GMAIL_APP_PWD in pc-agent environment (.env at repo root).
   */
  r.post('/gmail-snapshot', async (req, res) => {
    const b = req.body || {};
    const unreadCount = Math.min(50, Math.max(1, Number(b.unreadCount) || 15));
    const recentCount = Math.min(50, Math.max(1, Number(b.recentCount) || 12));
    try {
      const [unreadJson, recentJson] = await Promise.all([
        runPythonGmail(['unread', '--count', String(unreadCount)]),
        runPythonGmail(['list', '--count', String(recentCount)]),
      ]);
      const unread = JSON.parse(unreadJson);
      const recent = JSON.parse(recentJson);
      res.json({
        ok: true,
        ts: new Date().toISOString(),
        unread,
        recent,
      });
    } catch (e) {
      req.log?.warn({ err: String(e.message) }, 'gmail-snapshot failed');
      res.status(503).json({ ok: false, error: String(e.message || e) });
    }
  });

  return r;
}
