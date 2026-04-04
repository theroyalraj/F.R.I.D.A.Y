import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local neural TTS — free, no API. Requires Piper binary + .onnx model.
 * @see https://github.com/rhasspy/piper
 */
export function piperConfigured(env = process.env) {
  const bin = env.PIPER_PATH || '';
  const model = env.PIPER_MODEL || '';
  if (!bin || !model) return false;
  return existsSync(bin) && existsSync(model);
}

export function synthesizePiperWav(text, options) {
  const piperBin = options.piperBin;
  const modelPath = options.modelPath;
  const timeoutMs = options.timeoutMs ?? 120000;

  if (!text?.trim()) throw new Error('Empty text');

  const dir = mkdtempSync(join(tmpdir(), 'friday-piper-'));
  const outWav = join(dir, 'out.wav');
  try {
    const r = spawnSync(piperBin, ['--model', modelPath, '--output_file', outWav], {
      input: text,
      encoding: 'utf-8',
      maxBuffer: 80 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const err = (r.stderr && String(r.stderr)) || (r.stdout && String(r.stdout)) || '';
      throw new Error(err.trim() || `piper exited ${r.status}`);
    }
    return readFileSync(outWav);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
