/** Parse JSON from fetch; otherwise return a clear error (avoids DOCTYPE HTML noise). */
export async function safeReadJson(res: Response): Promise<{ ok: boolean; data: unknown; raw: string }> {
  const raw = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (!raw.trim()) {
    return { ok: res.ok, data: null, raw: '' };
  }
  if (!ct.includes('application/json') && raw.trimStart().startsWith('<')) {
    return {
      ok: false,
      data: {
        error: `Expected JSON but got HTML (${res.status}). If you use Vite on a custom port, proxy /integrations and /voice to pc-agent (port 3847), or open /friday/listen on the agent.`,
      },
      raw: raw.slice(0, 200),
    };
  }
  try {
    return { ok: res.ok, data: JSON.parse(raw), raw };
  } catch {
    return {
      ok: false,
      data: { error: `Invalid JSON: ${raw.slice(0, 120)}…` },
      raw,
    };
  }
}
