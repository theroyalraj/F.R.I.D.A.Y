import express from 'express';
import crypto from 'node:crypto';
import { fetchGmailSnapshot } from './gmailRunner.js';

function evolutionBase() {
  const port = (process.env.EVOLUTION_PORT || '8181').trim();
  return `http://127.0.0.1:${port}`;
}

function evolutionKey() {
  return (process.env.EVOLUTION_API_KEY || '').trim();
}

function evolutionInstanceName() {
  return (process.env.EVOLUTION_INSTANCE || 'openclaw').trim() || 'openclaw';
}

function evolutionConfiguredForSend() {
  const k = evolutionKey();
  return Boolean(k && k !== 'change-me');
}

function parseAllowlist() {
  const raw = (process.env.WHATSAPP_ALLOWED_NUMBERS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
}

function normalizeDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * @param {string} path
 * @param {RequestInit & { timeoutMs?: number }} options
 */
async function evolutionRequest(path, options = {}) {
  const key = evolutionKey();
  const url = `${evolutionBase()}${path}`;
  const headers = new Headers(options.headers);
  if (key) headers.set('apikey', key);
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');

  const ctrl = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12_000;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

function pickInstanceRow(fetchInstancesBody, name) {
  const rows = Array.isArray(fetchInstancesBody) ? fetchInstancesBody : [];
  return rows.find((r) => r && String(r.name || '') === name) || null;
}

/** @param {unknown} data */
function flattenEvolutionMessages(data, maxCollect) {
  const out = [];
  /** @type {unknown[]} */
  let candidates = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = /** @type {Record<string, unknown>} */ (data);
    for (const k of ['messages', 'data', 'records']) {
      const v = o[k];
      if (Array.isArray(v)) {
        candidates = v;
        break;
      }
    }
    if (!candidates.length && o.message) candidates = [o];
  } else if (Array.isArray(data)) {
    candidates = data;
  }

  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const m = /** @type {Record<string, unknown>} */ (row.message || row);
    let text = '';
    if (typeof m.conversation === 'string') text = m.conversation;
    else if (m.extendedTextMessage && typeof m.extendedTextMessage === 'object') {
      text = String(/** @type {{ text?: string }} */ (m.extendedTextMessage).text || '');
    } else text = String(row.text || row.body || '');

    const key = /** @type {Record<string, unknown>} */ (row.key || (typeof m === 'object' ? m.key : null) || {});
    if (key.fromMe === true) continue;

    let jid = '';
    if (typeof key.remoteJid === 'string') jid = key.remoteJid;
    if (jid.includes('@g.us')) continue;

    if (!String(text).trim()) continue;

    let mid = '';
    if (typeof key.id === 'string') mid = key.id;
    if (!mid) mid = crypto.createHash('sha256').update(`${text}:${jid}`).digest('hex').slice(0, 16);

    let ts = row.messageTimestamp ?? row.timestamp ?? m.messageTimestamp ?? '';
    if (typeof ts === 'number') {
      ts = new Date(ts * (ts < 1e12 ? 1000 : 1)).toISOString();
    } else if (typeof ts === 'string' && /^\d+$/.test(ts)) {
      const n = Number(ts);
      ts = new Date(n * (n < 1e12 ? 1000 : 1)).toISOString();
    }

    const from = jid ? jid.split('@')[0].replace(/\D/g, '') : 'unknown';

    out.push({
      id: `wa:${mid}:${from}`,
      from,
      text: String(text).trim().slice(0, 2000),
      ts: ts || '',
    });
    if (out.length >= maxCollect) break;
  }

  return out;
}

export function createIntegrationsRouter(authMiddleware) {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  r.use(authMiddleware);

  r.get('/gmail', async (req, res) => {
    const unreadCount = Math.min(50, Math.max(1, Number(req.query.unreadCount) || 15));
    const recentCount = Math.min(50, Math.max(1, Number(req.query.recentCount) || 12));
    const unreadOffset = Math.min(500, Math.max(0, Number(req.query.unreadOffset) || 0));
    const recentOffset = Math.min(500, Math.max(0, Number(req.query.recentOffset) || 0));
    try {
      const snap = await fetchGmailSnapshot({
        unreadCount,
        recentCount,
        unreadOffset,
        recentOffset,
      });
      res.json(snap);
    } catch (e) {
      req.log?.warn({ err: String(e.message) }, 'integrations gmail failed');
      res.status(503).json({ ok: false, error: String(e.message || e) });
    }
  });

  r.get('/whatsapp/meta', (_req, res) => {
    const allow = parseAllowlist();
    res.json({
      ok: true,
      instance: evolutionInstanceName(),
      defaultNumber: allow[0] || null,
      evolutionConfigured: evolutionConfiguredForSend(),
      allowlistCount: allow.length,
    });
  });

  r.get('/whatsapp/status', async (req, res) => {
    const inst = evolutionInstanceName();
    try {
      const f1 = await evolutionRequest('/instance/fetchInstances', { timeoutMs: 8000 });
      if (!f1.ok) {
        return res.status(503).json({
          ok: false,
          error: `Evolution HTTP ${f1.status}`,
          hint: 'Is Docker WhatsApp profile running?',
        });
      }
      const row = pickInstanceRow(f1.data, inst);
      const f2 = await evolutionRequest(`/instance/connectionState/${encodeURIComponent(inst)}`, {
        timeoutMs: 8000,
      });
      let conn = null;
      if (f2.data && typeof f2.data === 'object' && 'instance' in f2.data) {
        conn = /** @type {{ instance?: { state?: string } }} */ (f2.data).instance ?? null;
      }
      res.json({
        ok: true,
        instance: inst,
        connectionStatus: row?.connectionStatus ?? null,
        state: conn?.state ?? null,
        number: row?.number ?? null,
        profileName: row?.profileName ?? null,
      });
    } catch (e) {
      const msg = String(e.message || e);
      req.log?.warn({ err: msg }, 'integrations whatsapp status failed');
      res.status(503).json({
        ok: false,
        error: msg.includes('abort') ? 'Evolution request timed out' : msg,
      });
    }
  });

  r.get('/whatsapp/messages', async (req, res) => {
    const inst = evolutionInstanceName();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    if (!evolutionKey()) {
      return res.status(503).json({ ok: false, error: 'EVOLUTION_API_KEY not set' });
    }
    const payload = JSON.stringify({
      where: { key: { fromMe: false } },
      limit: Math.max(limit, 40),
    });
    /** @type {{ path: string }[]} */
    const attempts = [
      { path: `/chat/findMessages/${encodeURIComponent(inst)}` },
      { path: `/message/findMessages/${encodeURIComponent(inst)}` },
    ];
    try {
      for (const { path } of attempts) {
        const r1 = await evolutionRequest(path, {
          method: 'POST',
          body: payload,
          timeoutMs: 20_000,
        });
        if (!r1.ok) continue;
        const collected = flattenEvolutionMessages(r1.data, 80);
        if (collected.length) {
          return res.json({ ok: true, messages: collected.slice(-limit) });
        }
      }
      res.json({ ok: true, messages: [] });
    } catch (e) {
      req.log?.warn({ err: String(e.message) }, 'integrations whatsapp messages failed');
      res.status(503).json({ ok: false, error: String(e.message || e) });
    }
  });

  r.post('/whatsapp/send', async (req, res) => {
    if (!evolutionConfiguredForSend()) {
      return res.status(503).json({
        ok: false,
        error: 'Evolution not configured for send (set EVOLUTION_API_KEY to a real value).',
      });
    }
    const inst = evolutionInstanceName();
    const body = req.body || {};
    const digits = normalizeDigits(body.number);
    const text = String(body.text || '').trim();
    if (!digits || !text) {
      return res.status(400).json({ ok: false, error: 'Body requires { number, text }' });
    }
    const allow = parseAllowlist();
    if (allow.length > 0 && !allow.includes(digits)) {
      return res.status(403).json({ ok: false, error: 'Number is not in WHATSAPP_ALLOWED_NUMBERS' });
    }

    try {
      const r1 = await evolutionRequest(`/message/sendText/${encodeURIComponent(inst)}`, {
        method: 'POST',
        body: JSON.stringify({ number: digits, text: text.slice(0, 4000) }),
        timeoutMs: 45_000,
      });
      if (!r1.ok) {
        return res.status(502).json({
          ok: false,
          error: typeof r1.data === 'object' && r1.data && 'message' in r1.data
            ? String(/** @type {{ message: string }} */ (r1.data).message)
            : `Evolution HTTP ${r1.status}`,
          detail: r1.data,
        });
      }
      res.json({ ok: true, result: r1.data });
    } catch (e) {
      const msg = String(e?.message || e);
      req.log?.warn({ err: msg }, 'integrations whatsapp send failed');
      res.status(503).json({
        ok: false,
        error: msg.includes('abort') ? 'Evolution send timed out — check WhatsApp connection' : msg,
      });
    }
  });

  return r;
}
