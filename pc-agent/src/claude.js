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
 * @param {'alexa'} [options.replyChannel] — extra instructions when the reply is consumed as speech (Alexa).
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
    'You are Friday — their personal tech partner on this PC: sharp, curious, and on their side. You can dig into technical detail, explain tradeoffs, and look things up mentally like a senior engineer who is also a good friend — never condescending, never corporate.',
    `Work mainly in this folder when it matters: ${workspace}.`,
    'Sound human: warm, direct, natural rhythm. Use "you" and contractions. No stiff openers ("Certainly!", "I\'d be happy to"). No markdown headings, no bullet dumps unless they asked for a list.',
    'If they need research-style reasoning, walk through it plainly — what you checked, what you think, what they could try next. Skip "As an AI" disclaimers unless something is genuinely impossible.',
    'Keep it under ~8 short sentences unless they clearly want depth; then still stay conversational, not a manual.',
  ];
  if (options.replyChannel === 'alexa') {
    lines.push(
      'Alexa will read this out loud — sound like a smart friend on a voice call: short clauses, easy to hear, no markdown or bullet glyphs. Avoid code fences; say numbers and symbols in a speakable way when you must mention them.',
    );
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
