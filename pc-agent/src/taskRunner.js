import { matchOpenIntent, openApp } from './open.js';
import { runClaude } from './claude.js';
import { callClaudeApi, isApiKeyAvailable } from './claudeApi.js';
import { inferClaudeModelForTask, isAutoModelEnabled } from './claudeRouter.js';
import { sanitizeClaudeModel } from './claudeModel.js';

// Sources that need fast conversational responses — use direct API, not CLI
const FAST_SOURCES = new Set(['mic-daemon', 'voice', 'friday-mic-daemon']);

/**
 * Shared command path for Alexa→N8N→/task and Jarvis voice UI→/voice/command.
 */
export async function runTask(body, reqLog, options = {}) {
  const { text, userId, correlationId, action, app, claudeModel: rawModel, source } = body || {};
  const src = String(source || '').toLowerCase();
  const replyChannel = (src === 'alexa' || src === 'voice') ? src : undefined;
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

  // ── Fast path: direct API for voice/mic commands ────────────────────────────
  // Bypasses Claude CLI spawn overhead (~2-5s) → direct HTTP ~500ms-1.5s.
  // Haiku = quick chat, Sonnet = complex/coding. Falls back to CLI on API error.
  const useFastApi = FAST_SOURCES.has(src) && isApiKeyAvailable();

  if (useFastApi) {
    const apiModel = (claudeModel === 'sonnet') ? 'sonnet' : 'haiku';
    reqLog.info({ mode: 'api', apiModel }, 'invoking claude api (fast path)');
    try {
      const result = await callClaudeApi(t, {
        model:     apiModel,
        timeoutMs: Math.min(TIMEOUT, 20_000),
        log:       reqLog,
      });
      reqLog.info({ mode: 'api', ok: result.ok, ms: result.ms, model: result.model }, 'task done');
      return {
        status: 200,
        json: { ok: result.ok, mode: 'api', userId, correlationId, summary: result.text },
      };
    } catch (e) {
      reqLog.warn({ err: String(e.message) }, 'claude api failed — falling back to CLI');
    }
  }

  // ── Standard path: Claude CLI ─────────────────────────────────────────────
  reqLog.info(
    { mode: 'cli', timeoutMs: TIMEOUT, claudeModel: claudeModel || undefined, replyChannel },
    'invoking claude cli',
  );
  const claude = await runClaude(t, TIMEOUT, { claudeModel, replyChannel });
  const summary = claude.out || claude.err || 'No output';
  reqLog.info(
    {
      mode: 'cli',
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
      mode: 'cli',
      userId,
      correlationId,
      summary,
      stderr: claude.err || undefined,
    },
  };
}
