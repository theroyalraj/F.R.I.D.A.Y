#!/usr/bin/env node
/**
 * stdin or --file → OpenRouter chat completion → stdout summary.
 * Env: OPENROUTER_API_KEY (required), OPENROUTER_SONNET_MODEL or OPENROUTER_SUMMARY_MODEL (optional).
 */
import { readFileSync, existsSync } from 'node:fs';
const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
const model =
  (process.env.OPENROUTER_SUMMARY_MODEL || process.env.OPENROUTER_SONNET_MODEL || 'openai/gpt-4o-mini').trim();
const referer = (process.env.OPENROUTER_HTTP_REFERER || '').trim();
const appName = (process.env.OPENROUTER_APP_NAME || 'OpenClaw').trim();

function parseArgs() {
  const a = process.argv.slice(2);
  const file = a.includes('--file') ? a[a.indexOf('--file') + 1] : null;
  const promptArg = a.includes('--prompt') ? a[a.indexOf('--prompt') + 1] : null;
  return { file, promptArg };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (!apiKey) {
    console.error('[openrouter-summarize] Set OPENROUTER_API_KEY');
    process.exit(1);
  }

  const { file, promptArg } = parseArgs();
  let bodyText = '';
  if (file) {
    if (!existsSync(file)) {
      console.error('[openrouter-summarize] file not found:', file);
      process.exit(1);
    }
    bodyText = readFileSync(file, 'utf8');
  } else if (process.stdin.isTTY) {
    console.error('Usage: echo "text" | node openrouter-summarize.mjs');
    console.error('   or: node openrouter-summarize.mjs --file path.txt');
    process.exit(1);
  } else {
    bodyText = await readStdin();
  }

  const trimmed = bodyText.trim();
  if (!trimmed) {
    console.error('[openrouter-summarize] empty input');
    process.exit(1);
  }

  const system =
    promptArg ||
    'You summarize for a busy executive. Output 3 to 6 short bullet lines, plain text, no markdown fences.';

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (referer) headers['HTTP-Referer'] = referer;
  if (appName) headers['X-Title'] = appName;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: trimmed.slice(0, 120_000) },
      ],
      max_tokens: 512,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error('[openrouter-summarize] HTTP', res.status, t.slice(0, 500));
    process.exit(1);
  }

  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) {
    console.error('[openrouter-summarize] empty model response', JSON.stringify(data).slice(0, 400));
    process.exit(1);
  }
  process.stdout.write(out + '\n');
}

main().catch((e) => {
  console.error('[openrouter-summarize]', e);
  process.exit(1);
});
