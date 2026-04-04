/**
 * Shared Pino logger.
 * - Dev (no OPENCLAW_LOG_DIR): pretty stdout.
 * - OPENCLAW_LOG_DIR set: JSON to stdout + JSON file (use `tail -f logs/*.log | npx pino-pretty`).
 * - NODE_ENV=production: JSON stdout only unless log dir set.
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

export function createLogger(name) {
  const level =
    process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
  const dir = process.env.OPENCLAW_LOG_DIR;
  const isProd = process.env.NODE_ENV === 'production';
  const base = { service: name };
  const time = pino.stdTimeFunctions.isoTime;

  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.log`);
    return pino(
      { level, base, timestamp: time },
      pino.multistream([
        { level, stream: process.stdout },
        { level, stream: pino.destination({ dest: filePath, sync: false, mkdir: true }) },
      ]),
    );
  }

  if (!isProd) {
    return pino({
      level,
      base,
      timestamp: time,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino({ level, base, timestamp: time });
}
