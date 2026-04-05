import crypto from 'node:crypto';
import { matchOpenIntent, openApp } from './open.js';
import { matchPlayMusicIntent, playMusicSearch } from './playMusic.js';
import { runClaude } from './claude.js';
import { callClaudeApi, isApiKeyAvailable } from './claudeApi.js';
import {
  OPENROUTER_SETUP_MESSAGE,
  callOpenRouterCascade,
  isOpenRouterConfigured,
} from './openRouterApi.js';
import { buildVoiceSystem } from './claudeApi.js';
import { scheduleOpenRouterFallback } from './deferredOpenRouter.js';
import { inferClaudeModelForTask, isAutoModelEnabled } from './claudeRouter.js';
import { sanitizeClaudeModel } from './claudeModel.js';
import { getSpeakStyle, buildSpeakStyleInstruction } from './speakStyle.js';
import { getCachedCompanyContextString } from './companyDb.js';
import { getModelCascade, isClaudeFallbackEnabled, refreshModelPool } from './openRouterModelPool.js';
import { sanitizeConversationTail, flattenConversationForSingleShot } from './chatContext.js';
import { buildListenGmailContextBlock, listenGmailContextEnabledForSource } from './listenGmailContext.js';
import { tryReadAiCaches, persistAiGeneration, shouldBypassAiCache } from './aiTaskCache.js';
import { upsertConversationSession } from './learningSessionDb.js';
import { buildLearningContextBlock } from './learningRetrieval.js';
import { exposeGenerationIdInResponses, isLearningEnabled } from './learningEnv.js';
import { getVoiceAgentPersonasMerged } from './voiceAgentPersona.js';
import {
  resolveAssignedPersonaKey,
  isAssignedTask,
  buildPersonaInstruction,
  replyVoiceMeta,
} from './taskAssignRouting.js';

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

/** Stable fingerprint for CLI path cache keys (CLI system prompt differs from voice API). */
function cliCacheSystemString(companyContext, speakStyleExtra, model) {
  const payload = [
    'v1',
    String(companyContext || ''),
    String(speakStyleExtra || ''),
    String(model || ''),
    String(process.env.CLAUDE_MODEL || ''),
    String(process.env.CLAUDE_CLI_ARGS || ''),
  ].join('\x1e');
  return `cli-system:${crypto.createHash('sha256').update(payload, 'utf8').digest('hex')}`;
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
  const baseShot =
    tailOk.length > 0 ? flattenConversationForSingleShot(tailOk, t) : t;
  let shotPrompt = baseShot;
  if (listenGmailContextEnabledForSource(src)) {
    try {
      const mailCtx = await buildListenGmailContextBlock(reqLog);
      if (mailCtx) {
        shotPrompt = `${mailCtx}\n\n---\n\n${baseShot}`;
      }
    } catch (e) {
      reqLog?.warn({ err: String(e.message || e) }, 'listen gmail context failed — continuing without');
    }
  }

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

  /** @type {Record<string, string>} */
  let replyExtras = {};
  let personaInstruction = '';
  let assignedFast = false;
  if (FAST_SOURCES.has(src)) {
    const { merged } = await getVoiceAgentPersonasMerged();
    const personaKeyRaw = resolveAssignedPersonaKey(body);
    assignedFast = isAssignedTask(body, personaKeyRaw);
    const effectivePersonaKey = personaKeyRaw || (assignedFast ? 'jarvis' : null);
    if (effectivePersonaKey) {
      personaInstruction = buildPersonaInstruction(merged, effectivePersonaKey);
      replyExtras = replyVoiceMeta(merged, effectivePersonaKey);
    }
    if (assignedFast) {
      reqLog.info({ taskRoute: 'assigned', persona: effectivePersonaKey }, 'fast path: assigned → Claude-first');
    }
  }

  const systemForCache = buildVoiceSystem({ speakStyleExtra, companyContext, personaInstruction });

  let conversationSessionId = null;
  if (isLearningEnabled()) {
    const cskRaw =
      typeof body?.clientSessionId === 'string'
        ? body.clientSessionId
        : typeof body?.conversationSessionId === 'string'
          ? body.conversationSessionId
          : '';
    const csk = cskRaw.trim();
    if (csk) {
      conversationSessionId = await upsertConversationSession({
        userId: userId ?? '',
        orgId: options.orgId ?? null,
        source: src,
        clientSessionKey: csk,
        log: reqLog,
      });
    }
  }

  const tailDigest = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        n: tailOk.length,
        lens: tailOk.map((x) => String(x.content || '').length),
      }),
      'utf8',
    )
    .digest('hex');

  let learningBlock = '';
  if (isLearningEnabled() && !shouldBypassAiCache(body, src)) {
    learningBlock = await buildLearningContextBlock({
      shotPrompt,
      systemForCache,
      source: src,
      log: reqLog,
    });
  }

  /** @type {Record<string, unknown>} */
  const learningExtraMetadata = {
    ...(correlationId != null ? { correlationId: String(correlationId).slice(0, 200) } : {}),
    ...(conversationSessionId ? { conversationSessionId } : {}),
    tailDigest,
    ...(assignedFast ? { assignedFast: true } : {}),
    ...(learningBlock ? { learningInjection: learningBlock.slice(0, 2000) } : {}),
  };

  function generationJsonExtras(genId) {
    const o = {};
    if (exposeGenerationIdInResponses() && genId) o.generationLogId = genId;
    return o;
  }

  const systemWithLearning = learningBlock ? `${systemForCache}\n\n${learningBlock}` : systemForCache;

  /**
   * @param {{ summary: string, mode: string, model: string, provider?: string, fromCache: 'exact' | 'semantic' }} cached
   * @param {string} modelKey
   * @param {string} [systemStr]
   */
  async function finishFromCache(cached, modelKey, systemStr = systemForCache) {
    const latencyMs = Date.now() - t0;
    const genId = await persistAiGeneration({
      prompt: shotPrompt,
      system: systemStr,
      modelKey,
      responseText: cached.summary,
      model: cached.model,
      mode: cached.mode,
      provider: cached.provider || 'cache',
      source: src,
      latencyMs,
      orgId: options.orgId ?? null,
      userId: userId ?? null,
      log: reqLog,
      cacheHitType: cached.fromCache,
      extraMetadata: learningExtraMetadata,
    });
    reqLog.info({ mode: cached.mode, fromCache: cached.fromCache, ms: latencyMs }, 'task done (cache)');
    return {
      status: 200,
      json: {
        ok: true,
        mode: cached.mode,
        userId,
        correlationId,
        summary: cached.summary,
        cacheHit: cached.fromCache,
        ...replyExtras,
        ...generationJsonExtras(genId),
      },
    };
  }

  const openRouterDirectTimeoutMs =
    src === 'whatsapp' ? Math.min(TIMEOUT, 180_000) : Math.min(TIMEOUT, 45_000);

  // ── Assigned fast tasks: Claude API first (persona system prompt + reply voice) ───
  if (FAST_SOURCES.has(src) && assignedFast && isApiKeyAvailable()) {
    let apiTier = 'sonnet';
    if (claudeModel === 'opus') apiTier = 'opus';
    else if (claudeModel === 'haiku') apiTier = 'haiku';
    const apiTimeoutMs =
      src === 'whatsapp' ? Math.min(TIMEOUT, 180_000) : Math.min(TIMEOUT, 20_000);
    reqLog.info({ mode: 'api', apiTier, apiTimeoutMs, taskRoute: 'assigned' }, 'assigned → Claude API');
    try {
      const apiModelKey = `api:${apiTier}:assigned`;
      const cachedAssigned = await tryReadAiCaches({
        prompt: shotPrompt,
        system: systemForCache,
        modelKey: apiModelKey,
        source: src,
        body,
        log: reqLog,
      });
      if (cachedAssigned) return await finishFromCache(cachedAssigned, apiModelKey);

      const result = await callClaudeApi(t, {
        model: apiTier,
        timeoutMs: apiTimeoutMs,
        log: reqLog,
        speakStyleExtra,
        companyContext,
        personaInstruction,
        priorTurns: tailOk,
        learningContext: learningBlock || undefined,
      });
      if (result.needsOpenRouterKey) {
        reqLog.info({ mode: 'api', taskRoute: 'assigned' }, 'assigned: anthropic limited, no OpenRouter key');
        return {
          status: 200,
          json: {
            ok: false,
            mode: 'api',
            userId,
            correlationId,
            error: OPENROUTER_SETUP_MESSAGE,
            taskRoute: 'assigned-claude',
            ...replyExtras,
          },
        };
      }
      if (result.deferred && result.deferredContext) {
        scheduleOpenRouterFallback(result.deferredContext, {
          modelKey: `${apiModelKey}:openrouter-deferred`,
          mode: 'api',
          source: src,
          orgId: options.orgId ?? null,
          userId: userId ?? null,
          extraMetadata: learningExtraMetadata,
        });
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
            taskRoute: 'assigned-claude',
            ...replyExtras,
          },
        };
      }
      if (result.skippedAnthropicCooldown) {
        return {
          status: 200,
          json: {
            ok: true,
            mode: 'api',
            userId,
            correlationId,
            summary: '',
            speakAsync: false,
            taskRoute: 'assigned-claude',
            ...replyExtras,
          },
        };
      }
      if (result.ok && (result.text || '').trim()) {
        const genId = await persistAiGeneration({
          prompt: shotPrompt,
          system: systemForCache,
          modelKey: apiModelKey,
          responseText: result.text,
          model: result.model,
          mode: 'api',
          provider: 'anthropic',
          source: src,
          latencyMs: result.ms,
          orgId: options.orgId ?? null,
          userId: userId ?? null,
          log: reqLog,
          extraMetadata: learningExtraMetadata,
        });
        return {
          status: 200,
          json: {
            ok: true,
            mode: 'api',
            userId,
            correlationId,
            summary: result.text,
            taskRoute: 'assigned-claude',
            ...replyExtras,
            ...generationJsonExtras(genId),
          },
        };
      }
    } catch (e) {
      reqLog.warn({ err: String(e?.message || e) }, 'assigned Claude API failed — will try OpenRouter if configured');
    }
  }

  // ── OpenRouter free (cascade): preferred for unassigned fast path; fallback for assigned if Claude unavailable/failed ────
  if (FAST_SOURCES.has(src) && isOpenRouterConfigured()) {
    // Background-refresh pool from OpenRouter /models API (non-blocking after first load)
    refreshModelPool({ log: reqLog }).catch(() => {});

    const cascade = await getModelCascade(4);
    reqLog.info(
      { mode: 'openrouter', cascade, apiTimeoutMs: openRouterDirectTimeoutMs },
      'openrouter cascade (free models)',
    );

    if (cascade.length > 0) {
      const system = systemWithLearning;
      const orFreeModelKey = `or-free:${cascade.join('|')}`;
      const cachedOr = await tryReadAiCaches({
        prompt: shotPrompt,
        system: systemForCache,
        modelKey: orFreeModelKey,
        source: src,
        body,
        log: reqLog,
      });
      if (cachedOr) return await finishFromCache(cachedOr, orFreeModelKey);

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
        const genOr = await persistAiGeneration({
          prompt: shotPrompt,
          system: systemForCache,
          modelKey: orFreeModelKey,
          responseText: result.text,
          model: result.model,
          mode: 'openrouter',
          provider: 'openrouter',
          source: src,
          latencyMs: result.ms,
          orgId: options.orgId ?? null,
          userId: userId ?? null,
          log: reqLog,
          extraMetadata: learningExtraMetadata,
        });
        return {
          status: 200,
          json: {
            ok: true,
            mode: 'openrouter',
            userId,
            correlationId,
            summary: result.text,
            taskRoute: assignedFast ? 'assigned-openrouter' : 'openrouter',
            ...replyExtras,
            ...generationJsonExtras(genOr),
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
        const opusFallbackKey = 'api:opus:claude-fallback';
        const cachedOpusFb = await tryReadAiCaches({
          prompt: shotPrompt,
          system: systemForCache,
          modelKey: opusFallbackKey,
          source: src,
          body,
          log: reqLog,
        });
        if (cachedOpusFb) return await finishFromCache(cachedOpusFb, opusFallbackKey);

        const opusResult = await callClaudeApi(t, {
          model: 'opus',
          timeoutMs: openRouterDirectTimeoutMs,
          log: reqLog,
          speakStyleExtra,
          companyContext,
          personaInstruction,
          priorTurns: tailOk,
          learningContext: learningBlock || undefined,
        });
        if (opusResult.ok && (opusResult.text || '').trim()) {
          reqLog.info(
            { mode: 'api', model: opusResult.model, ms: opusResult.ms, via: 'claude-fallback' },
            'Claude Opus fallback succeeded',
          );
          const genOpus = await persistAiGeneration({
            prompt: shotPrompt,
            system: systemForCache,
            modelKey: opusFallbackKey,
            responseText: opusResult.text,
            model: opusResult.model,
            mode: 'claude-fallback',
            provider: 'anthropic',
            source: src,
            latencyMs: opusResult.ms,
            orgId: options.orgId ?? null,
            userId: userId ?? null,
            log: reqLog,
            extraMetadata: learningExtraMetadata,
          });
          return {
            status: 200,
            json: {
              ok: true,
              mode: 'claude-fallback',
              userId,
              correlationId,
              summary: opusResult.text,
              taskRoute: assignedFast ? 'assigned-openrouter-fallback' : 'openrouter-fallback',
              ...replyExtras,
              ...generationJsonExtras(genOpus),
            },
          };
        }
        if (opusResult.deferred && opusResult.deferredContext) {
          scheduleOpenRouterFallback(opusResult.deferredContext, {
            modelKey: `${opusFallbackKey}:openrouter-deferred`,
            mode: 'claude-fallback',
            source: src,
            orgId: options.orgId ?? null,
            userId: userId ?? null,
            extraMetadata: learningExtraMetadata,
          });
          return {
            status: 200,
            json: {
              ok: true,
              mode: 'claude-fallback',
              userId,
              correlationId,
              summary: '',
              deferredOpenRouter: true,
              ...replyExtras,
            },
          };
        }
      } catch (e) {
        reqLog.warn({ err: String(e?.message || e).slice(0, 200) }, 'Claude Opus fallback also failed');
      }
    }

    reqLog.warn(
      { mode: 'openrouter' },
      'OpenRouter cascade exhausted — falling back to Claude API fast path when available',
    );
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
      const apiModelKey = `api:${apiTier}`;
      const cachedApi = await tryReadAiCaches({
        prompt: shotPrompt,
        system: systemForCache,
        modelKey: apiModelKey,
        source: src,
        body,
        log: reqLog,
      });
      if (cachedApi) return await finishFromCache(cachedApi, apiModelKey);

      const result = await callClaudeApi(t, {
        model:     apiTier,
        timeoutMs: apiTimeoutMs,
        log:       reqLog,
        speakStyleExtra,
        companyContext,
        personaInstruction,
        priorTurns: tailOk,
        learningContext: learningBlock || undefined,
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
            ...replyExtras,
          },
        };
      }
      if (result.deferred && result.deferredContext) {
        scheduleOpenRouterFallback(result.deferredContext, {
          modelKey: `${apiModelKey}:openrouter-deferred`,
          mode: 'api',
          source: src,
          orgId: options.orgId ?? null,
          userId: userId ?? null,
          extraMetadata: learningExtraMetadata,
        });
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
            taskRoute: 'claude-fast',
            ...replyExtras,
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
            taskRoute: 'claude-fast',
            ...replyExtras,
          },
        };
      }
      reqLog.info({ mode: 'api', ok: result.ok, ms: result.ms, model: result.model }, 'task done');
      let genFast = null;
      if (result.ok && (result.text || '').trim()) {
        genFast = await persistAiGeneration({
          prompt: shotPrompt,
          system: systemForCache,
          modelKey: apiModelKey,
          responseText: result.text,
          model: result.model,
          mode: 'api',
          provider: 'anthropic',
          source: src,
          latencyMs: result.ms,
          orgId: options.orgId ?? null,
          userId: userId ?? null,
          log: reqLog,
          extraMetadata: learningExtraMetadata,
        });
      }
      return {
        status: 200,
        json: {
          ok: result.ok,
          mode: 'api',
          userId,
          correlationId,
          summary: result.text,
          taskRoute: 'claude-fast',
          ...replyExtras,
          ...generationJsonExtras(genFast),
        },
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
  const cliModelKey = `cli:${claudeModel || 'auto'}`;
  const cliSystemStub = cliCacheSystemString(companyContext, speakStyleExtra, claudeModel);
  const cachedCli = await tryReadAiCaches({
    prompt: shotPrompt,
    system: cliSystemStub,
    modelKey: cliModelKey,
    source: src,
    body,
    log: reqLog,
  });
  if (cachedCli) return await finishFromCache(cachedCli, cliModelKey, cliSystemStub);

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
  let genCli = null;
  if (claude.ok && summary && summary !== 'No output') {
    genCli = await persistAiGeneration({
      prompt: shotPrompt,
      system: cliSystemStub,
      modelKey: cliModelKey,
      responseText: summary,
      model: claudeModel || process.env.CLAUDE_MODEL || 'cli',
      mode: 'cli',
      provider: 'claude-cli',
      source: src,
      latencyMs: Date.now() - t0,
      orgId: options.orgId ?? null,
      userId: userId ?? null,
      log: reqLog,
      extraMetadata: learningExtraMetadata,
    });
  }
  return {
    status: 200,
    json: {
      ok: claude.ok,
      mode: 'cli',
      userId,
      correlationId,
      summary,
      stderr: claude.err || undefined,
      ...generationJsonExtras(genCli),
    },
  };
}
