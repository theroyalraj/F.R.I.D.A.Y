import { fetchGmailSnapshot } from './gmailRunner.js';

/** Sources where Raj uses the Listen dashboard or mic — include inbox snapshot for mail questions. */
const SOURCES_WITH_GMAIL_CONTEXT = new Set([
  'ui',
  'voice',
  'mic-daemon',
  'friday-mic-daemon',
  'cursor-ui',
]);

function envBool(key, defaultValue) {
  const raw = String(process.env[key] ?? '').trim().toLowerCase();
  if (raw === '') return defaultValue;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function gmailCredentialsPresent() {
  return Boolean(
    String(process.env.GMAIL_ADDRESS || '').trim() && String(process.env.GMAIL_APP_PWD || '').trim(),
  );
}

export function listenGmailContextEnabledForSource(source) {
  if (!envBool('FRIDAY_LISTEN_INCLUDE_GMAIL', true)) return false;
  if (!gmailCredentialsPresent()) return false;
  const src = String(source || '').toLowerCase();
  return SOURCES_WITH_GMAIL_CONTEXT.has(src);
}

function contextTtlMs() {
  const n = Number(process.env.FRIDAY_LISTEN_GMAIL_CONTEXT_TTL_MS);
  if (Number.isFinite(n) && n >= 0) return Math.min(120_000, Math.max(0, n));
  return 30_000;
}

let cache = { at: 0, text: '' };

/**
 * Returns a short text block for the model, or '' if skipped / error.
 * Cached for FRIDAY_LISTEN_GMAIL_CONTEXT_TTL_MS to avoid IMAP on every utterance.
 */
export async function buildListenGmailContextBlock(log) {
  if (!gmailCredentialsPresent()) return '';

  const ttl = contextTtlMs();
  const now = Date.now();
  if (ttl > 0 && cache.text && now - cache.at < ttl) {
    return cache.text;
  }

  const unreadN = Math.min(12, Math.max(3, Number(process.env.FRIDAY_LISTEN_GMAIL_UNREAD_N) || 6));
  const recentN = Math.min(12, Math.max(3, Number(process.env.FRIDAY_LISTEN_GMAIL_RECENT_N) || 6));

  const snap = await fetchGmailSnapshot({
    unreadCount: unreadN,
    recentCount: recentN,
  });

  const unread = Array.isArray(snap.unread) ? snap.unread : [];
  const recent = Array.isArray(snap.recent) ? snap.recent : [];

  const lines = [];
  lines.push(`INBOX SNAPSHOT (as of ${snap.ts || new Date().toISOString()})`);
  lines.push(
    'Use this when Raj asks about email; keep spoken answers short. UIDs are for reference only.',
  );

  if (unread.length) {
    lines.push('Unread:');
    for (const m of unread) {
      const from = String(m.from || '').replace(/\s+/g, ' ').trim().slice(0, 72);
      const subj = String(m.subject || '').replace(/\s+/g, ' ').trim().slice(0, 88);
      lines.push(`- uid ${m.uid} | ${from} | ${subj}`);
    }
  } else {
    lines.push('Unread: (none in this batch)');
  }

  if (recent.length) {
    lines.push('Recent:');
    for (const m of recent) {
      const from = String(m.from || '').replace(/\s+/g, ' ').trim().slice(0, 72);
      const subj = String(m.subject || '').replace(/\s+/g, ' ').trim().slice(0, 88);
      lines.push(`- uid ${m.uid} | ${from} | ${subj}`);
    }
  }

  const block = lines.join('\n');
  if (ttl > 0) {
    cache = { at: now, text: block };
  }
  log?.info?.({ unread: unread.length, recent: recent.length }, 'listen gmail context attached');
  return block;
}
