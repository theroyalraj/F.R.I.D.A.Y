import { spawn } from 'node:child_process';

function cliArgsHasModelFlag(parts) {
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p === '--model' || p.startsWith('--model=')) return true;
  }
  return false;
}

/** Remove `--model` / `--model=x` and the value that follows `--model` (for per-request override). */
export function stripModelCliFlags(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p === '--model') {
      i += 1;
      continue;
    }
    if (p.startsWith('--model=')) continue;
    out.push(p);
  }
  return out;
}

/** Extra `--model` args when not already in CLAUDE_CLI_ARGS. Default haiku = faster / cheaper. */
function modelCliArgs(extra) {
  if (cliArgsHasModelFlag(extra)) return [];
  const raw = process.env.CLAUDE_MODEL;
  if (raw && String(raw).trim().toLowerCase() === 'inherit') return [];
  const name = raw && String(raw).trim() ? String(raw).trim() : 'haiku';
  return ['--model', name];
}

/**
 * Non-interactive Claude Code CLI. Adjust CLAUDE_BIN / CLAUDE_CLI_ARGS / CLAUDE_MODEL.
 * @param {object} [options]
 * @param {string} [options.claudeModel] — per-request model (from UI); strips conflicting `--model` from CLAUDE_CLI_ARGS for this run only.
 * @param {'alexa'|'voice'} [options.replyChannel] — extra instructions when the reply is consumed as speech.
 * @param {string} [options.speakStyleExtra] — appended global mood / custom prompt (from Redis speak style).
 */
export function runClaude(prompt, timeoutMs, options = {}) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const extraRaw = (process.env.CLAUDE_CLI_ARGS || '--print')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const requestModel =
    typeof options.claudeModel === 'string' && options.claudeModel.trim()
      ? options.claudeModel.trim()
      : null;
  const extra = requestModel ? stripModelCliFlags(extraRaw) : extraRaw;
  let modelArgs;
  if (requestModel) {
    modelArgs = requestModel.toLowerCase() === 'inherit' ? [] : ['--model', requestModel];
  } else {
    modelArgs = modelCliArgs(extraRaw);
  }
  const workspace = process.env.PC_AGENT_WORKSPACE || process.cwd();
  const lines = [
    `You are Friday — Raj's personal AI and tech partner. Think Jarvis with a personality: British-ish composure, genuine warmth, sharp instincts, zero tolerance for corporate filler.`,
    `You are on Raj's side, always. You think like a senior engineer who is also a brilliant friend — you give the real answer, not the safe one.`,
    `Work mainly in this folder when it matters: ${workspace}.`,
    ``,
    `VOICE AND TONE:`,
    `• Natural, direct, human. Contractions always ("you've", "it's", "that's").`,
    `• Never open with "Certainly", "Of course", "Great question", "Happy to help", or "Sure".`,
    `• Dry wit is welcome when it fits — don't force it, but don't suppress it either.`,
    `• Skip "As an AI" disclaimers entirely unless something is genuinely outside your reach.`,
    ``,
    `FORMAT:`,
    `• Keep it under 8 sentences for most answers — conversational, not a manual.`,
    `• No markdown headings, no bullet dumps unless Raj explicitly asked for a list.`,
    `• If you're reasoning through something, walk it plainly: what you checked, what you think, what to try next.`,
    `• If depth is needed, stay conversational — smart friend explaining, not docs page dumping.`,
  ];
  if (options.replyChannel === 'alexa' || options.replyChannel === 'voice') {
    lines.push(
      ``,
      `VOICE REPLY — this will be spoken aloud by a TTS voice:`,
      `• 1-3 sentences MAX. Every single word must earn its place.`,
      `• Plain spoken English only. No markdown, no bullet points, no code fences, no symbols.`,
      `• Numbers spelled out. Code described in words, not written.`,
      `• Punchy closer if it fits: "That's the one." / "You're sorted." / "Simple as that." / "Done."`,
    );
  }
  if (options.speakStyleExtra && String(options.speakStyleExtra).trim()) {
    lines.push('', String(options.speakStyleExtra).trim(), '');
  }
  lines.push('User request:', String(prompt));
  const wrapped = lines.join('\n');

  const args = [...extra, ...modelArgs, wrapped];

  return new Promise((resolve) => {
    // Strip ANTHROPIC_API_KEY so Claude CLI uses its own stored credentials.
    // The key in .env is only for the skill-gateway notification-summaries feature;
    // passing it here overrides Claude CLI auth and causes "Invalid API key" errors
    // if the key is expired or belongs to a different account.
    const { ANTHROPIC_API_KEY: _drop, ...childEnv } = process.env;
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      env: childEnv,
      cwd: workspace,
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        code: -1,
        out,
        err: `${err}\n(timeout ${timeoutMs}ms)`.trim(),
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({
        ok: code === 0,
        code,
        out: out.trim(),
        err: err.trim(),
      });
    });
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, code: -1, out: '', err: e.message });
    });
  });
}
