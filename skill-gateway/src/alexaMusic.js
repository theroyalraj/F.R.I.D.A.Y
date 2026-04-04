/**
 * alexaMusic.js — send music commands to an Alexa device via alexa-remote2.
 *
 * First-time setup:
 *   1. Run:  node scripts/setup-alexa-cookie.mjs
 *   2. Visit http://127.0.0.1:3001 in your browser and log in with your Amazon account.
 *   3. Cookie is saved to .alexa-cookie.json and loaded automatically.
 *
 * Env vars:
 *   AMAZON_ALEXA_COOKIE     — raw Amazon session cookie string (alternative to file)
 *   ALEXA_MUSIC_DEVICE      — device name substring (default: FRIDAY_TTS_DEVICE or "Echo")
 *   ALEXA_MUSIC_PROVIDER    — music provider (default: AMAZON_MUSIC; try SPOTIFY)
 *   ALEXA_MUSIC_ENABLED     — set "false" to disable (default: true when cookie present)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = path.resolve(__dirname, '../../.alexa-cookie.json');

let _alexa   = null;
let _devices = null;
let _ready   = false;
let _initPromise = null;

function loadCookie() {
  if (process.env.AMAZON_ALEXA_COOKIE?.trim()) return process.env.AMAZON_ALEXA_COOKIE.trim();
  if (existsSync(COOKIE_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
      return raw.cookie || raw.alexaCookie || raw;
    } catch { return null; }
  }
  return null;
}

export function alexaMusicConfigured() {
  if (process.env.ALEXA_MUSIC_ENABLED === 'false') return false;
  return Boolean(loadCookie());
}

async function initAlexa(log) {
  if (_ready) return true;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const cookie = loadCookie();
    if (!cookie) return false;

    let AlexaRemote;
    try {
      ({ default: AlexaRemote } = await import('alexa-remote2'));
    } catch (e) {
      log?.warn({ err: String(e.message) }, 'alexa-remote2 not installed — run: npm install alexa-remote2 --workspace=skill-gateway');
      return false;
    }

    return new Promise((resolve) => {
      const alexa = new AlexaRemote();
      alexa.init(
        {
          alexaCookie: cookie,
          amazonPage: process.env.AMAZON_PAGE || 'amazon.com',
          logger: (msg) => log?.debug({ alexaRemote: msg }),
          alexaServiceHost: process.env.ALEXA_SERVICE_HOST || 'alexa.amazon.com',
          cookieRefreshInterval: 0,
        },
        (err) => {
          if (err) {
            log?.warn({ err: String(err) }, 'alexaMusic: init failed');
            resolve(false);
            return;
          }
          _alexa = alexa;
          _ready = true;
          log?.info('alexaMusic: connected');
          resolve(true);
        },
      );
    });
  })();

  return _initPromise;
}

async function getTargetDevice(log) {
  if (_devices) return _devices;
  const hint = (process.env.ALEXA_MUSIC_DEVICE || process.env.FRIDAY_TTS_DEVICE || 'Echo').toLowerCase();
  return new Promise((resolve) => {
    _alexa.getDevices((err, data) => {
      if (err || !data?.devices?.length) {
        log?.warn({ err: String(err) }, 'alexaMusic: could not list devices');
        resolve(null);
        return;
      }
      const device =
        data.devices.find((d) => d.accountName?.toLowerCase().includes(hint)) ||
        data.devices.find((d) => d.deviceFamily === 'ECHO') ||
        data.devices[0];
      _devices = device;
      log?.info({ device: device?.accountName }, 'alexaMusic: target device');
      resolve(device);
    });
  });
}

/**
 * Tell an Alexa device to play a song / artist / playlist.
 *
 * @param {string} searchPhrase   e.g. "Back in Black by AC DC"
 * @param {import('pino').Logger} [log]
 */
export async function alexaPlayMusic(searchPhrase, log) {
  if (!alexaMusicConfigured()) return;

  const ready = await initAlexa(log);
  if (!ready) return;

  const device = await getTargetDevice(log);
  if (!device) return;

  const provider = process.env.ALEXA_MUSIC_PROVIDER || 'AMAZON_MUSIC';

  try {
    await new Promise((resolve, reject) => {
      _alexa.sendSequenceCommand(
        device.serialNumber,
        'Music.playSearchPhrase',
        { searchPhrase, musicProviderId: provider },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    log?.info({ searchPhrase, provider, device: device.accountName }, 'alexaMusic: play sent');
  } catch (e) {
    // Fallback: try as a text command ("Alexa, play X")
    try {
      await new Promise((resolve, reject) => {
        _alexa.sendCommand(
          device.serialNumber,
          `play ${searchPhrase}`,
          device.deviceType,
          (err) => (err ? reject(err) : resolve()),
        );
      });
      log?.info({ searchPhrase, via: 'text-command' }, 'alexaMusic: play sent (text-command fallback)');
    } catch (e2) {
      log?.warn({ err: String(e2.message) }, 'alexaMusic: play failed');
    }
  }
}

/**
 * Tell Alexa to stop playing.
 * @param {import('pino').Logger} [log]
 */
export async function alexaStopMusic(log) {
  if (!alexaMusicConfigured() || !_ready) return;
  const device = await getTargetDevice(log);
  if (!device) return;
  _alexa.sendCommand(device.serialNumber, 'pause', device.deviceType, () => {});
}
