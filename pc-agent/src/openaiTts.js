/**
 * OpenAI Audio API — natural speech (tts-1 / tts-1-hd).
 * @see https://platform.openai.com/docs/guides/text-to-speech
 */
export async function synthesizeOpenAiMp3(text, options = {}) {
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error('Missing API key');

  const model = options.model || 'tts-1-hd';
  const voice = options.voice || 'nova';
  const timeoutMs = options.timeoutMs ?? 120000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: 'mp3',
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`OpenAI TTS HTTP ${r.status}: ${err.slice(0, 300)}`);
    }

    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export function openAiTtsConfigured(env = process.env) {
  if (env.FRIDAY_TTS_DISABLED === '1' || env.FRIDAY_TTS_DISABLED === 'true') return false;
  if (env.FRIDAY_TTS_OPENAI !== '1' && env.FRIDAY_TTS_OPENAI !== 'true') return false;
  return Boolean(env.OPENAI_API_KEY || env.FRIDAY_OPENAI_API_KEY);
}

export function openAiTtsApiKey(env = process.env) {
  return env.FRIDAY_OPENAI_API_KEY || env.OPENAI_API_KEY || '';
}
