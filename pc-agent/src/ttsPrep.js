/** Strip code / noise for TTS (OpenAI limit 4096 chars). */
export function prepareTextForTts(raw) {
  if (!raw || typeof raw !== 'string') return 'Done.';
  let t = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]+`/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 4090) t = t.slice(0, 4090) + '…';
  return t || 'Done.';
}
