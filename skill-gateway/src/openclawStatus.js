/**
 * Aggregated OpenClaw status for GET /openclaw/status (schedules + last cron run + child service health).
 */
import http from 'node:http';
import { getBriefingCronSnapshot } from './briefingCron.js';

function envBool(key, defaultVal = false) {
  const v = String(process.env[key] ?? '').trim().toLowerCase();
  if (v === '') return defaultVal;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function envInt(key, def) {
  const raw = String(process.env[key] ?? '').split('#')[0].trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

function envFloat(key, def) {
  const raw = String(process.env[key] ?? '').split('#')[0].trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

export async function buildOpenclawStatus() {
  const now = new Date().toISOString();
  const uptimeSec = Math.floor(process.uptime());
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

  let pcAgent = { ok: false, error: 'not requested' };
  try {
    pcAgent = await fetchJson('http://127.0.0.1:3847/health', 2000);
  } catch (err) {
    pcAgent = { ok: false, error: String(err?.message || err) };
  }

  const trackerPollSec = Math.max(60, envInt('FRIDAY_TRACKER_POLL_SEC', 900));
  const musicIntervalMin = envFloat('FRIDAY_MUSIC_INTERVAL_MIN', 30);
  const musicSchedOn = envBool('FRIDAY_MUSIC_SCHEDULER', false);

  const pcPort = envInt('PC_AGENT_PORT', 3847);

  return {
    ok: true,
    service: 'openclaw-skill-gateway',
    now,
    links: {
      self: `http://127.0.0.1:${envInt('PORT', 3848)}/openclaw/status`,
      listenOpenclawStatus: `http://127.0.0.1:${pcPort}/openclaw/status`,
      pcAgentHealth: `http://127.0.0.1:${pcPort}/health`,
      personasJson: `http://127.0.0.1:${pcPort}/settings/personas`,
    },
    gateway: {
      uptimeSec,
      startedAt,
    },
    briefingCron: getBriefingCronSnapshot(),
    schedules: {
      actionTrackerDaemon: {
        note: 'Python friday-action-tracker.py when started via start.mjs',
        enabled: envBool('FRIDAY_TRACKER_ENABLED', true),
        pollIntervalSec: trackerPollSec,
        runBriefingInLoop: envBool('FRIDAY_TRACKER_RUN_BRIEFING_IN_LOOP', true),
        gatewayCronOwnsBriefing: envBool('FRIDAY_BRIEFING_GATEWAY_CRON', false),
      },
      musicScheduler: {
        note: 'Python friday-music-scheduler.py when FRIDAY_MUSIC_SCHEDULER is on',
        enabled: musicSchedOn,
        intervalMinutes: musicIntervalMin,
        autoplayOn: envBool('FRIDAY_AUTOPLAY', true),
      },
    },
    pcAgent,
  };
}
