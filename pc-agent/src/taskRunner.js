import { matchOpenIntent, openApp } from './open.js';
import { runClaude } from './claude.js';
import { inferClaudeModelForTask, isAutoModelEnabled } from './claudeRouter.js';
import { sanitizeClaudeModel } from './claudeModel.js';

/**
 * Shared command path for Alexa→N8N→/task and Jarvis voice UI→/voice/command.
 */
export async function runTask(body, reqLog, options = {}) {
  const { text, userId, correlationId, action, app, claudeModel: rawModel, source } = body || {};
  const replyChannel = String(source || '').toLowerCase() === 'alexa' ? 'alexa' : undefined;
  const t = typeof text === 'string' ? text.trim() : '';
  const TIMEOUT = options.claudeTimeoutMs ?? Number(process.env.CLAUDE_TIMEOUT_MS || 180000);
  let claudeModel = sanitizeClaudeModel(rawModel);
  if (rawModel != null && String(rawModel).trim() && !claudeModel) {
    reqLog.warn({ claudeModelRaw: String(rawModel).slice(0, 80) }, 'ignored invalid claudeModel');
  }

  reqLog.info(
    {
      correlationId,
      userId: userId ? '(present)' : undefined,
      action,
      app,
      claudeModel: claudeModel || undefined,
      source: replyChannel || undefined,
      textLen: t.length,
      textPreview: t.slice(0, 100),
    },
    'task start',
  );

  const t0 = Date.now();

  if (action === 'open_app' && app) {
    const r = await openApp(app);
    reqLog.info({ mode: 'open_app', ok: r.ok, ms: Date.now() - t0 }, 'task done');
    return {
      status: 200,
      json: {
        ok: r.ok,
        mode: 'open_app',
        userId,
        correlationId,
        summary: r.detail,
      },
    };
  }

  const key = t ? matchOpenIntent(t) : null;
  if (key) {
    const r = await openApp(key);
    reqLog.info({ mode: 'open_app', app: key, ok: r.ok, ms: Date.now() - t0 }, 'task done');
    return {
      status: 200,
      json: {
        ok: r.ok,
        mode: 'open_app',
        userId,
        correlationId,
        summary: r.detail,
      },
    };
  }

  if (!t) {
    reqLog.warn('task rejected: missing text');
    return { status: 400, json: { error: 'Missing text' } };
  }

  if (!claudeModel && isAutoModelEnabled()) {
    const inferred = inferClaudeModelForTask(t);
    if (inferred) {
      claudeModel = inferred;
      reqLog.info({ claudeModelInferred: inferred }, 'auto model from prompt');
    }
  }

  reqLog.info(
    { mode: 'claude', timeoutMs: TIMEOUT, claudeModel: claudeModel || undefined, replyChannel },
    'invoking claude cli',
  );
  const claude = await runClaude(t, TIMEOUT, { claudeModel, replyChannel });
  const summary = claude.out || claude.err || 'No output';
  reqLog.info(
    {
      mode: 'claude',
      exitCode: claude.code,
      ok: claude.ok,
      ms: Date.now() - t0,
      outLen: (claude.out || '').length,
      errLen: (claude.err || '').length,
    },
    'task done',
  );
  return {
    status: 200,
    json: {
      ok: claude.ok,
      mode: 'claude',
      userId,
      correlationId,
      summary,
      stderr: claude.err || undefined,
    },
  };
}
