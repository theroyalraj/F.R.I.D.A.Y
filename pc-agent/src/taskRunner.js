import { matchOpenIntent, openApp } from './open.js';
import { matchPlayMusicIntent, playMusicSearch } from './playMusic.js';
import { runClaude } from './claude.js';
import { callClaudeApi, isApiKeyAvailable } from './claudeApi.js';
import {
  OPENROUTER_SETUP_MESSAGE,
  callOpenRouterChat,
  callOpenRouterCascade,
  isOpenRouterConfigured,
  openRouterFreeModel,
} from './openRouterApi.js';
import { buildVoiceSystem } from './claudeApi.js';
import { scheduleOpenRouterFallback } from './deferredOpenRouter.js';
import { inferClaudeModelForTask, isAutoModelEnabled } from './claudeRouter.js';
import { sanitizeClaudeModel } from './claudeModel.js';
import { getSpeakStyle, buildSpeakStyleInstruction } from './speakStyle.js';
import { getCachedCompanyContextString } from './companyDb.js';
import { getModelCascade, isClaudeFallbackEnabled, refreshModelPool } from './openRouterModelPool.js';
import { sanitizeConversationTail, flattenConversationForSingleShot } from './chatContext.js';

// Sources that need fast conversational responses — use direct API, not CLI
const FAST_SOURCES = new Set([
  'mic-daemon',
  'voice',
  'friday-mic-daemon',
  'whatsapp',
  'ui',
  'cursor-ui',
]);

function shouldApplySpeakStyle(source, replyChannel) {
  if (replyChannel === 'alexa' || replyChannel === 'voice') return true;
  return FAST_SOURCES.has(String(source || '').toLowerCase());
}

/**
 * Shared command path for Alexa→N8N→/task and Jarvis voice UI→/voice/command.
 * @param {object} [options]
 * @param {string|null} [options.orgId] — from JWT; loads org company profile for Claude/TTS context
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

  if (action === 'play_music' && typeof body?.query === 'string' && body.query.trim()) {
    const q = body.query.trim();
    const r = await playMusicSearch(q);
    reqLog.info({ mode: 'play_music', ok: r.ok, ms: Date.now() - t0 }, 'task done');
    return {
      status: 200,
      json: {
        ok: r.ok,
        mode: 'play_music',
        userId,
        correlationId,
        musicQuery: q,
        summary: r.detail,
      },
    };
  }

  const playQuery = t ? matchPlayMusicIntent(t) : null;
  if (playQuery) {
    const r = await playMusicSearch(playQuery);
    reqLog.info({ mode: 'play_music', query: playQuery, ok: r.ok, ms: Date.now() - t0 }, 'task done');
    return {
      status: 200,
      json: {
        ok: r.ok,
        mode: 'play_music',
        userId,
        correlationId,
        musicQuery: playQuery,
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

  const priorTurns = sanitizeConversationTail(body);
  const tailOk =
    src === 'ui' || src === 'cursor-ui'
      ? priorTurns
      : [];
  const shotPrompt =
    tailOk.length > 0 ? flattenConversationForSingleShot(tailOk, t) : t;

  let speakStyleExtra = '';
  if (shouldApplySpeakStyle(src, replyChannel)) {
    try {
      const st = await getSpeakStyle();
      speakStyleExtra = buildSpeakStyleInstruction(st);
    } catch {
      /* ignore */
    }
  }

  let companyContext = '';
  if (options.orgId) {
    try {
      companyContext = await getCachedCompanyContextString(options.orgId);
    } catch {
      /* DB down or SQLite backend — skip org context */
    }
  }

  if ((!claudeModel || claudeModel === 'auto') && isAutoModelEnabled()) {
    const inferred = inferClaudeModelForTask(t);
    if (inferred) {
      claudeModel = inferred;
      reqLog.info({ claudeModelInferred: inferred }, 'auto model from prompt');
    }
  }

  // ── OpenRouter free (cascade): try pool models, fall back to Claude Opus ────
  const openRouterDirectTimeoutMs =
    src === 'whatsapp' ? Math.min(TIMEOUT, 180_000) : Math.min(TIMEOUT, 45_000);

  if (FAST_SOURCES.has(src) && claudeModel === 'openrouter-free') {
    if (!isOpenRouterConfigured()) {
      reqLog.warn({ mode: 'openrouter' }, 'openrouter-free selected but OPENROUTER_API_KEY missing');
      return {
        status: 200,
        json: {
          ok: false,
          mode: 'openrouter',
          userId,
          correlationId,
          error: OPENROUTER_SETUP_MESSAGE,
        },
      };
    }

    // Background-refresh pool from OpenRouter /models API (non-blocking after first load)
    refreshModelPool({ log: reqLog }).catch(() => {});

    const cascade = await getModelCascade(4);
    reqLog.info(
      { mode: 'openrouter', cascade, apiTimeoutMs: openRouterDirectTimeoutMs },
      'openrouter cascade (free models)',
    );

    if (cascade.length > 0) {
      const system = buildVoiceSystem({ speakStyleExtra, companyContext });
      const result = await callOpenRouterCascade({
        prompt: shotPrompt,
        system,
        models: cascade,
        timeoutMs: openRouterDirectTimeoutMs,
        log: reqLog,
      });

      if (result.ok && (result.text || '').trim()) {
        reqLog.info(
          { mode: 'openrouter', ok: true, ms: result.ms, model: result.model, attempts: result.attempts },
          'openrouter cascade done',
        );
        return {
          status: 200,
          json: {
            ok: true,
            mode: 'openrouter',
            userId,
            correlationId,
            summary: result.text,
          },
        };
      }

      reqLog.warn(
        { mode: 'openrouter', attempts: result.attempts, lastError: result.lastError },
        'openrouter cascade: all free models failed',
      );
    } else {
      reqLog.warn({ mode: 'openrouter' }, 'openrouter cascade: pool empty (all models in cooldown)');
    }

    // ── Fallback to Claude Opus via Anthropic API ──
    if (isClaudeFallbackEnabled() && isApiKeyAvailable()) {
      reqLog.info({ mode: 'api', tier: 'opus', via: 'claude-fallback' }, 'free models exhausted — falling back to Claude Opus');
      try {
        const opusResult = await callClaudeApi(t, {
          model: 'opus',
          timeoutMs: openRouterDirectTimeoutMs,
          log: reqLog,
          speakStyleExtra,
          companyContext,
          priorTurns: tailOk,
        });
        if (opusResult.ok && (opusResult.text || '').trim()) {
          reqLog.info(
            { mode: 'api', model: opusResult.model, ms: opusResult.ms, via: 'claude-fallback' },
            'Claude Opus fallback succeeded',
          );
          return {
            status: 200,
            json: {
              ok: true,
              mode: 'claude-fallback',
              userId,
              correlationId,
              summary: opusResult.text,
            },
          };
        }
        if (opusResult.deferred && opusResult.deferredContext) {
          scheduleOpenRouterFallback(opusResult.deferredContext);
          return {
            status: 200,
            json: {
              ok: true,
              mode: 'claude-fallback',
              userId,
              correlationId,
              summary: '',
              deferredOpenRouter: true,
            },
          };
        }
      } catch (e) {
        reqLog.warn({ err: String(e?.message || e).slice(0, 200) }, 'Claude Opus fallback also failed');
      }
    }

    return {
      status: 200,
      json: {
        ok: false,
        mode: 'openrouter',
        userId,
        correlationId,
        error: 'All free models rate-limited and Claude fallback unavailable. Try again shortly.',
      },
    };
  }

  // ── Fast path: direct API for voice/mic commands ────────────────────────────
  // Bypasses Claude CLI spawn overhead (~2-5s) → direct HTTP ~500ms-1.5s.
  // Default tier Sonnet; Opus when inferred or selected; Haiku if explicitly chosen. On Anthropic rate limit, OpenRouter if configured.
  const useFastApi = FAST_SOURCES.has(src) && isApiKeyAvailable();

  if (useFastApi) {
    let apiTier = 'sonnet';
    if (claudeModel === 'opus') apiTier = 'opus';
    else if (claudeModel === 'haiku') apiTier = 'haiku';
    const apiTimeoutMs =
      src === 'whatsapp' ? Math.min(TIMEOUT, 180_000) : Math.min(TIMEOUT, 20_000);
    reqLog.info({ mode: 'api', apiTier, apiTimeoutMs }, 'invoking claude api (fast path)');
    try {
      const result = await callClaudeApi(t, {
        model:     apiTier,
        timeoutMs: apiTimeoutMs,
        log:       reqLog,
        speakStyleExtra,
        companyContext,
        priorTurns: tailOk,
      });
      if (result.needsOpenRouterKey) {
        reqLog.info({ mode: 'api' }, 'task done — anthropic limited, openrouter key missing');
        return {
          status: 200,
          json: {
            ok: false,
            mode: 'api',
            userId,
            correlationId,
            error: OPENROUTER_SETUP_MESSAGE,
          },
        };
      }
      if (result.deferred && result.deferredContext) {
        scheduleOpenRouterFallback(result.deferredContext);
        reqLog.info(
          {
            mode: 'api',
            deferredOpenRouter: true,
            cooldownSkip: Boolean(result.skippedAnthropicCooldown),
          },
          'task ack — OpenRouter scheduled async',
        );
        return {
          status: 200,
          json: {
            ok: true,
            mode: 'api',
            userId,
            correlationId,
            summary: '',
            speakAsync: false,
            deferredOpenRouter: true,
          },
        };
      }
      if (result.skippedAnthropicCooldown) {
        reqLog.info({ mode: 'api' }, 'task ack — anthropic cooldown, silent (no OpenRouter)');
        return {
          status: 200,
          json: {
            ok: true,
            mode: 'api',
            userId,
            correlationId,
            summary: '',
            speakAsync: false,
          },
        };
      }
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
  const claude = await runClaude(shotPrompt, TIMEOUT, {
    claudeModel,
    replyChannel,
    speakStyleExtra,
    companyContext,
  });
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
