import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Merge ~/.openclaw/config.json into process.env (after dotenv). */
export function loadOpenclawUserConfig() {
  try {
    const p = path.join(os.homedir(), '.openclaw', 'config.json');
    if (!existsSync(p)) return;
    const raw = readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return;
    for (const [k, v] of Object.entries(j)) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      process.env[k] = s;
    }
  } catch {
    /* ignore */
  }
}
