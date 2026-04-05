/**
 * Optional direct pc-agent intake — skips N8N when OPENCLAW_DIRECT_INTAKE is true.
 * Mirrors n8n/workflows/friday-intake.json: POST /task then POST /internal/last-result.
 */
import crypto from 'node:crypto';

const PC_AGENT_URL = (process.env.PC_AGENT_URL || process.env.PC_AGENT_INTERNAL_URL || 'http://127.0.0.1:3847').replace(
  /\/$/,
  '',
);
const PC_AGENT_SECRET = (process.env.PC_AGENT_SECRET || '').trim();
const GATEWAY_SELF = (process.env.GATEWAY_INTERNAL_SELF_URL || `http://127.0.0.1:${process.env.PORT || 3848}`).replace(
  /\/$/,
  '',
);

/** @returns {boolean} */
export function useDirectIntake() {
  const v = (process.env.OPENCLAW_DIRECT_INTAKE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * @param {object} payload - Same shape as N8N friday-intake body (commandText, userId, correlationId, source, …)
 * @param {{ info: Function, warn: Function, error: Function }} reqLog
 * @param {string | undefined} n8nWebhookSecret - same as N8N_WEBHOOK_SECRET for /internal/last-result
 */
export async function enqueueDirectToPcAgent(payload, reqLog, n8nWebhookSecret) {
  const t0 = Date.now();
  const cmd = String(payload.commandText ?? '').trim();
  if (!cmd) {
    reqLog.warn('direct intake: empty commandText — skip');
    return;
  }

  if (payload.lambdaLaunchProbe === true && String(payload.requestType || '') === 'LaunchRequest') {
    reqLog.info('direct intake: lambda launch probe — skip');
    return;
  }

  if (!PC_AGENT_SECRET) {
    reqLog.error('direct intake: PC_AGENT_SECRET not set');
    return;
  }

  const body = {
    text: cmd,
    userId: payload.userId || 'anonymous',
    correlationId: payload.correlationId || crypto.randomUUID(),
    source: String(payload.source || 'direct-intake').slice(0, 48),
  };

  try {
    const r = await fetch(`${PC_AGENT_URL}/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PC_AGENT_SECRET}`,
      },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));
    const summary =
      typeof data.summary === 'string' && data.summary.trim()
        ? data.summary.trim()
        : typeof data.error === 'string'
          ? `Error: ${data.error}`
          : `Task finished (HTTP ${r.status})`;

    if (n8nWebhookSecret) {
      const lr = await fetch(`${GATEWAY_SELF}/internal/last-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Openclaw-Secret': n8nWebhookSecret,
        },
        body: JSON.stringify({
          userId: body.userId,
          message: summary,
          correlationId: body.correlationId,
          notify: true,
        }),
      });
      if (!lr.ok) {
        reqLog.warn(
          { status: lr.status, ms: Date.now() - t0 },
          'direct intake: last-result POST failed',
        );
      }
    } else {
      reqLog.warn('direct intake: N8N_WEBHOOK_SECRET empty — skipped last-result notify');
    }

    reqLog.info(
      {
        directIntake: true,
        pcStatus: r.status,
        ok: Boolean(data.ok),
        ms: Date.now() - t0,
        correlationId: body.correlationId,
      },
      'direct pc-agent task completed',
    );
  } catch (e) {
    reqLog.error({ err: String(e.message || e), ms: Date.now() - t0 }, 'direct intake failed');
  }
}
