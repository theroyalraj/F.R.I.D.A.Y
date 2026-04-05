/** Mirrors scripts/openclaw_company.py PERSONAS (speaking roles). Atlas omitted — listen-only. */

export const COMPANY_PERSONAS = {
  jarvis: {
    name: 'Jarvis',
    title: 'Chief of Staff',
    voice: 'en-US-AvaMultilingualNeural',
    personality: 'Composed, warm, confident — your primary executive assistant.',
  },
  argus: {
    name: 'Argus',
    title: 'VP, Security & Compliance',
    voice: 'en-US-GuyNeural',
    personality: 'Dry, watchful, direct; no-nonsense on pending reviews.',
  },
  nova: {
    name: 'Nova',
    title: 'Director of Communications',
    voice: 'en-GB-SoniaNeural',
    personality: 'Polished, concise; delivers briefings like a news lead.',
  },
  sage: {
    name: 'Sage',
    title: 'Head of Research',
    voice: 'en-US-AndrewMultilingualNeural',
    personality: 'Measured, academic; narrates reasoning aloud.',
  },
  dexter: {
    name: 'Dexter',
    title: 'Lead Engineer',
    voice: 'en-US-EricNeural',
    personality: 'Methodical, lightly nerdy; standup-style updates.',
  },
  maestro: {
    name: 'Maestro',
    title: 'Creative Director',
    voice: 'en-US-BrianMultilingualNeural',
    personality: 'Witty, relaxed; music, culture, and colour commentary.',
  },
  harper: {
    name: 'Harper',
    title: 'Executive Assistant',
    voice: 'en-US-JennyNeural',
    personality: 'Organised, supportive; reminders without nagging.',
  },
  sentinel: {
    name: 'Sentinel',
    title: 'IT Operations',
    voice: 'en-IE-ConnorNeural',
    personality: 'Understated relay; reads Composer output when enabled.',
  },
  echo: {
    name: 'Echo',
    title: 'Director of Presence',
    voice: 'en-US-MichelleNeural',
    personality: 'Warm check-ins when the room has been quiet; invites interaction without nagging.',
  },
} as const;

export type CompanyPersonaKey = keyof typeof COMPANY_PERSONAS;
export type PersonaOverride = { title?: string; personality?: string };

/** Merged / server shape (Postgres voice_agent_personas + defaults). */
export type PersonaCatalog = Record<
  string,
  { name?: string; title?: string; voice?: string; personality?: string; rate?: string }
>;

const STORAGE_KEY = 'openclaw.personaOverrides';

export function loadPersonaOverrides(): Record<string, PersonaOverride> {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return {};
    const o = JSON.parse(s);
    return typeof o === 'object' && o ? o : {};
  } catch {
    return {};
  }
}

export function savePersonaOverrides(overrides: Record<string, PersonaOverride>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

/** Keys shown in the team / voice pool (Jarvis first as default team lead). */
export const SPEAKING_PERSONA_ORDER: CompanyPersonaKey[] = [
  'jarvis',
  'dexter',
  'sage',
  'argus',
  'nova',
  'maestro',
  'harper',
  'sentinel',
  'echo',
];

export interface ChatBubblePersona {
  id: string;
  name: string;
  title: string;
  voice: string;
  personality: string;
}

export function inferPersonaKeyFromVoice(
  voice: string,
  catalog: PersonaCatalog | null = null,
): CompanyPersonaKey | 'custom' {
  const v = String(voice || '').trim();
  if (!v) return 'jarvis';
  const cat = catalog ?? (COMPANY_PERSONAS as unknown as PersonaCatalog);
  for (const key of SPEAKING_PERSONA_ORDER) {
    const row = cat[key as string];
    const id = row?.voice ?? (COMPANY_PERSONAS as Record<string, { voice: string }>)[key]?.voice;
    if (id === v) return key;
  }
  return 'custom';
}

export function mergePersona(
  key: CompanyPersonaKey | 'custom',
  overrides: Record<string, PersonaOverride>,
  customVoiceId: string,
  catalog: PersonaCatalog | null = null,
): ChatBubblePersona {
  if (key === 'custom') {
    return {
      id: 'custom',
      name: 'Custom voice',
      title: 'Catalogue pick',
      voice: customVoiceId || '',
      personality: 'Edge voice chosen directly from the full catalogue.',
    };
  }
  const staticBase = COMPANY_PERSONAS[key];
  const row = catalog?.[key as string];
  const base = {
    name: row?.name?.trim() || staticBase.name,
    title: row?.title?.trim() || staticBase.title,
    voice: row?.voice?.trim() || staticBase.voice,
    personality: row?.personality?.trim() || staticBase.personality,
  };
  const o = overrides[key] || {};
  const title =
    typeof o.title === 'string' && o.title.trim() !== '' ? o.title.trim() : base.title;
  const personality =
    typeof o.personality === 'string' && o.personality.trim() !== ''
      ? o.personality.trim()
      : base.personality;
  return {
    id: key,
    name: base.name,
    title,
    voice: base.voice,
    personality,
  };
}

export function shortVoiceLabel(voiceId: string): string {
  const id = String(voiceId || '');
  const m = id.match(/-(\w+)Neural$/);
  return m ? m[1] : id.slice(-12) || '—';
}

/* ── Orb palette ──────────────────────────────────────────────────────────── */

export type OrbPalette = {
  /** Accent color used for ring border, core glow, wave disk inner. */
  primary: string;
  /** Darker / secondary accent for core gradient and conic tail. */
  secondary: string;
  /** Complementary for the halo conic gradient (used alongside primary). */
  complement: string;
};

export const PERSONA_ORB_PALETTES: Record<CompanyPersonaKey | 'custom', OrbPalette> = {
  jarvis:   { primary: '#a78bfa', secondary: '#7c3aed', complement: '#38bdf8' },
  argus:    { primary: '#34d399', secondary: '#059669', complement: '#a3e635' },
  nova:     { primary: '#e879f9', secondary: '#a21caf', complement: '#f472b6' },
  sage:     { primary: '#60a5fa', secondary: '#1d4ed8', complement: '#94a3b8' },
  dexter:   { primary: '#fbbf24', secondary: '#b45309', complement: '#fb923c' },
  maestro:  { primary: '#fb923c', secondary: '#c2410c', complement: '#fbbf24' },
  harper:   { primary: '#fb7185', secondary: '#be123c', complement: '#f472b6' },
  sentinel: { primary: '#7dd3fc', secondary: '#0369a1', complement: '#60a5fa' },
  echo:     { primary: '#2dd4bf', secondary: '#0f766e', complement: '#34d399' },
  custom:   { primary: '#8b5cf6', secondary: '#6d28d9', complement: '#38bdf8' },
};

/** Default palette used before any speak event resolves the persona. */
export const DEFAULT_ORB_PALETTE: OrbPalette = PERSONA_ORB_PALETTES.jarvis;

/** VOICE_META icon per persona key (client-only convenience; voice IDs must match COMPANY_PERSONAS). */
const PERSONA_ICONS: Record<CompanyPersonaKey, string> = {
  jarvis:   '👩‍💼',
  argus:    '👨‍💼',
  nova:     '👸',
  sage:     '🧑‍🔬',
  dexter:   '👨‍🔬',
  maestro:  '🎭',
  harper:   '🙋‍♀️',
  sentinel: '📡',
  echo:     '🧑‍🎤',
};

export function personaIcon(key: CompanyPersonaKey | 'custom'): string {
  if (key === 'custom') return '🎙️';
  return PERSONA_ICONS[key] ?? '🎙️';
}

/** Shown on user-authored bubbles (typed or voice-heard). */
export const USER_BUBBLE_PERSONA: ChatBubblePersona = {
  id: 'you',
  name: 'You',
  title: 'Operator',
  voice: 'This session',
  personality: 'Messages you send or speak from this Listen dashboard.',
};
