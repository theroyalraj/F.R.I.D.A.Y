#!/usr/bin/env node
/**
 * One-time setup: authenticate alexa-remote2 via a local proxy browser flow.
 *
 * Run once:
 *   node scripts/setup-alexa-cookie.mjs
 *
 * Then open http://127.0.0.1:3001 in a browser, log in with your Amazon account.
 * The cookie is saved to .alexa-cookie.json in the repo root.
 * Add .alexa-cookie.json to .gitignore (already there).
 *
 * After setup, restart the skill-gateway — it will load the cookie automatically.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE_FILE = path.join(root, '.alexa-cookie.json');

let AlexaRemote;
try {
  ({ default: AlexaRemote } = await import('alexa-remote2'));
} catch {
  console.error('alexa-remote2 not installed. Run: npm install alexa-remote2 --workspace=skill-gateway');
  process.exit(1);
}

console.log('\n══════════════════════════════════════════════════════');
console.log('  Friday — Alexa Cookie Setup');
console.log('══════════════════════════════════════════════════════');
console.log('\n  Starting proxy on http://127.0.0.1:3999 …');
console.log('  Open that URL in your browser and log in to Amazon.');
console.log('  Cookie will be saved to .alexa-cookie.json\n');

const alexa = new AlexaRemote();

alexa.init(
  {
    proxyOnly: true,
    proxyOwnIp: '127.0.0.1',
    proxyPort: 3999,
    amazonPage: 'amazon.com',
    cookieRefreshInterval: 0,
    logger: (msg) => process.stdout.write(`  [proxy] ${msg}\n`),
    alexaServiceHost: 'alexa.amazon.com',
  },
  (err, res) => {
    if (err) {
      console.error('\n  Setup failed:', err.message || err);
      process.exit(1);
    }

    // Save the cookie
    const cookie = alexa.cookieData || res;
    writeFileSync(COOKIE_FILE, JSON.stringify({ cookie }, null, 2), 'utf8');
    console.log('\n  ✓ Cookie saved to .alexa-cookie.json');
    console.log('  Restart skill-gateway to activate Alexa music control.\n');
    process.exit(0);
  },
);
