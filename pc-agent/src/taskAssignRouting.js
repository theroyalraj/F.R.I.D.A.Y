/**
 * Assigned-task routing: when a request is tied to a voice-agent persona, use Claude for reasoning
 * and return the correct Edge voice / persona key for TTS. Unassigned fast-path callers use OpenRouter first.
 */
import { VOICE_AGENT_PERSONA_DEFAULTS } from './voiceAgentPersona.js';

const KNOWN_PERSONAS = new Set(Object.keys(VOICE_AGENT_PERSONA_DEFAULTS));

/**
 * @param {Record<string, unknown>} body — /task or /voice/command body
 * @returns {string | null} canonical persona key or null
 */
export function resolveAssignedPersonaKey(body) {
  if (!body || typeof body !== 'object') return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  const candidates = [
    b.assignedPersona,
    b.personaKey,
    b.assigneePersona,
    b.agent,
    b.assignee && typeof b.assignee === 'object' ? /** @type {Record<string, unknown>} */ (b.assignee).personaKey : null,
    b.assignee && typeof b.assignee === 'object' ? /** @type {Record<string, unknown>} */ (b.assignee).key : null,
    b.task && typeof b.task === 'object' ? /** @type {Record<string, unknown>} */ (b.task).assignedPersona : null,
    b.task && typeof b.task === 'object' ? /** @type {Record<string, unknown>} */ (b.task).personaKey : null,
  ];
  for (const c of candidates) {
    const k = String(c || '')
      .trim()
      .toLowerCase();
    if (k && KNOWN_PERSONAS.has(k)) return k;
  }
  return null;
}

/**
 * Explicit assignment: persona key and/or taskAssigned / routing flag from upstream (Jira, UI, etc.).
 * @param {Record<string, unknown> | null | undefined} body
 * @param {string | null} personaKey — from resolveAssignedPersonaKey
 */
export function isAssignedTask(body, personaKey) {
  if (personaKey) return true;
  if (!body || typeof body !== 'object') return false;
  const b = /** @type {Record<string, unknown>} */ (body);
  const routing = String(b.routing || '').toLowerCase();
  if (routing === 'assigned' || routing === 'claude') return true;
  if (b.taskAssigned === true || b.assignedTask === true) return true;
  return false;
}

/**
 * @param {Record<string, object>} merged — getVoiceAgentPersonasMerged().merged
 * @param {string} key
 */
export function buildPersonaInstruction(merged, key) {
  if (!key || !merged || typeof merged !== 'object') return '';
  const p = merged[key];
  if (!p || typeof p !== 'object') return '';
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : key;
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const personality = typeof p.personality === 'string' ? p.personality.trim() : '';
  const lines = [
    `Assigned voice-agent for this turn: ${name}${title ? ` — ${title}` : ''}.`,
    personality ? `Character: ${personality}` : '',
    'Stay in this persona for the spoken reply: short, natural speech, no markdown or bullet lists.',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * @param {Record<string, object>} merged
 * @param {string} key
 * @returns {Record<string, string>}
 */
export function replyVoiceMeta(merged, key) {
  if (!key) return {};
  const p = merged?.[key];
  const voice =
    p && typeof p === 'object' && typeof p.voice === 'string' ? p.voice.trim() : '';
  const out = /** @type {Record<string, string>} */ ({ replyPersonaKey: key });
  if (voice) out.replyVoice = voice;
  return out;
}
