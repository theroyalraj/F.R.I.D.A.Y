/**
 * Voice Avatar System
 * Photo portraits use Pexels crops credited on https://www.untitledui.com/avatars (Untitled UI FREE avatars).
 */

export type AvatarStyle = 'disney' | 'realistic';

export interface AvatarConfig {
  voice: string;
  name: string;
  style: AvatarStyle;
  initials: string;
  emoji: string;
  primaryColor: string;
  secondaryColor: string;
  trait: string; // e.g., "enthusiastic", "calm", "analytical"
  /** Optional real portrait (Untitled UI–style stock); when set, UI prefers photo over emoji. */
  photoUrl?: string;
}

/** Operator bubble (user) — Pexels / Ashwin Santiago per Untitled UI avatars page. */
export const USER_OPERATOR_PHOTO_URL =
  'https://images.pexels.com/photos/2379004/pexels-photo-2379004.jpeg?auto=compress&cs=tinysrgb&w=256&h=256&fit=crop';

function px(id: number): string {
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=256&h=256&fit=crop`;
}

// Avatar configuration for each voice
export const VOICE_AVATARS: Record<string, AvatarConfig> = {
  'en-US-EmmaMultilingualNeural': {
    voice: 'en-US-EmmaMultilingualNeural',
    name: 'Emma',
    style: 'disney',
    initials: 'EM',
    emoji: '👩‍💼',
    primaryColor: '#a78bfa',
    secondaryColor: '#d8b4fe',
    trait: 'enthusiastic',
    photoUrl: px(7552448),
  },
  'en-US-AriaNeural': {
    voice: 'en-US-AriaNeural',
    name: 'Aria',
    style: 'disney',
    initials: 'AR',
    emoji: '👩',
    primaryColor: '#f472b6',
    secondaryColor: '#fbcfe8',
    trait: 'expressive',
    photoUrl: px(7275385),
  },
  'en-US-JennyNeural': {
    voice: 'en-US-JennyNeural',
    name: 'Jenny',
    style: 'realistic',
    initials: 'JN',
    emoji: '🙋‍♀️',
    primaryColor: '#fb923c',
    secondaryColor: '#fed7aa',
    trait: 'friendly',
    photoUrl: px(7244701),
  },
  'en-US-NancyNeural': {
    voice: 'en-US-NancyNeural',
    name: 'Nancy',
    style: 'disney',
    initials: 'NC',
    emoji: '👩‍💻',
    primaryColor: '#38bdf8',
    secondaryColor: '#bae6fd',
    trait: 'professional',
    photoUrl: px(4972985),
  },
  'en-US-GuyNeural': {
    voice: 'en-US-GuyNeural',
    name: 'Guy',
    style: 'realistic',
    initials: 'GY',
    emoji: '👨‍💼',
    primaryColor: '#34d399',
    secondaryColor: '#a7f3d0',
    trait: 'casual',
    photoUrl: px(3785079),
  },
  'en-US-ChristopherNeural': {
    voice: 'en-US-ChristopherNeural',
    name: 'Christopher',
    style: 'disney',
    initials: 'CH',
    emoji: '👨',
    primaryColor: '#60a5fa',
    secondaryColor: '#bfdbfe',
    trait: 'confident',
    photoUrl: px(7388867),
  },
  'en-US-DavisNeural': {
    voice: 'en-US-DavisNeural',
    name: 'Davis',
    style: 'realistic',
    initials: 'DV',
    emoji: '🧔',
    primaryColor: '#a3e635',
    secondaryColor: '#dcfce7',
    trait: 'analytical',
    photoUrl: px(7971171),
  },
  'en-US-EricNeural': {
    voice: 'en-US-EricNeural',
    name: 'Eric',
    style: 'disney',
    initials: 'ER',
    emoji: '👨‍🔧',
    primaryColor: '#fbbf24',
    secondaryColor: '#fef08a',
    trait: 'technical',
    photoUrl: px(5862269),
  },
  'en-GB-LibbyNeural': {
    voice: 'en-GB-LibbyNeural',
    name: 'Libby',
    style: 'realistic',
    initials: 'LB',
    emoji: '👩‍🎓',
    primaryColor: '#c084fc',
    secondaryColor: '#f5d0fd',
    trait: 'educated',
    photoUrl: px(8107620),
  },
  'en-GB-SoniaNeural': {
    voice: 'en-GB-SoniaNeural',
    name: 'Sonia',
    style: 'disney',
    initials: 'SN',
    emoji: '👸',
    primaryColor: '#e879f9',
    secondaryColor: '#f8d5fe',
    trait: 'elegant',
    photoUrl: px(2744193),
  },
  'en-IN-NeerjaExpressiveNeural': {
    voice: 'en-IN-NeerjaExpressiveNeural',
    name: 'Neerja',
    style: 'realistic',
    initials: 'NJ',
    emoji: '🕺',
    primaryColor: '#fb7185',
    secondaryColor: '#fecdd3',
    trait: 'expressive',
    photoUrl: px(4685042),
  },
  'en-IN-PrabhatNeural': {
    voice: 'en-IN-PrabhatNeural',
    name: 'Prabhat',
    style: 'disney',
    initials: 'PB',
    emoji: '👨‍🏫',
    primaryColor: '#2dd4bf',
    secondaryColor: '#ccfbf1',
    trait: 'thoughtful',
    photoUrl: px(7927472),
  },
  'en-AU-NatashaNeural': {
    voice: 'en-AU-NatashaNeural',
    name: 'Natasha',
    style: 'realistic',
    initials: 'NT',
    emoji: '👩‍🎤',
    primaryColor: '#f97316',
    secondaryColor: '#fed7aa',
    trait: 'vibrant',
    photoUrl: px(3796217),
  },
  'en-CA-LiamNeural': {
    voice: 'en-CA-LiamNeural',
    name: 'Liam',
    style: 'disney',
    initials: 'LM',
    emoji: '🧑',
    primaryColor: '#22d3ee',
    secondaryColor: '#cffafe',
    trait: 'friendly',
    photoUrl: px(8727417),
  },
  'en-CA-ClaraNeural': {
    voice: 'en-CA-ClaraNeural',
    name: 'Clara',
    style: 'realistic',
    initials: 'CL',
    emoji: '👩‍🎨',
    primaryColor: '#a78bfa',
    secondaryColor: '#ddd6fe',
    trait: 'creative',
    photoUrl: px(6962024),
  },
  'en-US-AndrewMultilingualNeural': {
    voice: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew',
    style: 'disney',
    initials: 'AN',
    emoji: '🧑‍🔬',
    primaryColor: '#94a3b8',
    secondaryColor: '#e2e8f0',
    trait: 'technical',
    photoUrl: px(7584926),
  },
  'en-US-BrianMultilingualNeural': {
    voice: 'en-US-BrianMultilingualNeural',
    name: 'Brian',
    style: 'realistic',
    initials: 'BR',
    emoji: '🎭',
    primaryColor: '#a8a29e',
    secondaryColor: '#e7e5e4',
    trait: 'theatrical',
    photoUrl: px(6626903),
  },
  'en-US-AvaMultilingualNeural': {
    voice: 'en-US-AvaMultilingualNeural',
    name: 'Ava',
    style: 'disney',
    initials: 'AV',
    emoji: '👩‍💼',
    primaryColor: '#f0abfc',
    secondaryColor: '#f9e7fe',
    trait: 'professional',
    photoUrl: px(4347368),
  },
  'en-IE-ConnorNeural': {
    voice: 'en-IE-ConnorNeural',
    name: 'Connor',
    style: 'realistic',
    initials: 'CN',
    emoji: '📧',
    primaryColor: '#7dd3fc',
    secondaryColor: '#cffafe',
    trait: 'personable',
    photoUrl: px(3214789),
  },
  'en-US-MichelleNeural': {
    voice: 'en-US-MichelleNeural',
    name: 'Michelle',
    style: 'realistic',
    initials: 'MI',
    emoji: '👩‍🎤',
    primaryColor: '#2dd4bf',
    secondaryColor: '#99f6e4',
    trait: 'warm',
    photoUrl: px(6375914),
  },
};

/**
 * Get avatar config for a voice
 */
export function getAvatarConfig(voiceId: string): AvatarConfig {
  return VOICE_AVATARS[voiceId] || {
    voice: voiceId,
    name: voiceId.split('-').pop() || 'Voice',
    style: 'disney',
    initials: voiceId.substring(0, 2).toUpperCase(),
    emoji: '🎙️',
    primaryColor: '#8b5cf6',
    secondaryColor: '#e9d5ff',
    trait: 'neutral',
  };
}

/**
 * Avatar animation states for speaking
 */
export const SPEAKING_ANIMATIONS = {
  lips: [
    { openness: 0, duration: 100 },    // closed
    { openness: 0.3, duration: 80 },   // slightly open
    { openness: 0.6, duration: 100 },  // medium open
    { openness: 0.3, duration: 80 },   // slightly open
  ],
  head: [
    { tilt: 0, bob: 0, duration: 150 },
    { tilt: 3, bob: 2, duration: 150 },
    { tilt: -2, bob: 0, duration: 150 },
    { tilt: 0, bob: 0, duration: 150 },
  ],
  eyes: [
    { blink: 0, focus: 0, duration: 100 },
    { blink: 0, focus: 0, duration: 200 },
    { blink: 1, focus: 0, duration: 50 },
    { blink: 0, focus: 0, duration: 50 },
  ],
};

/**
 * Cache manager for avatars
 */
export class AvatarCache {
  private static readonly CACHE_KEY = 'friday:avatar-cache';
  private static readonly CACHE_VERSION = 2;

  static get(): Record<string, AvatarConfig> {
    try {
      const cached = localStorage.getItem(this.CACHE_KEY);
      if (cached) {
        const data = JSON.parse(cached);
        if (data.version === this.CACHE_VERSION) {
          return data.avatars;
        }
      }
    } catch {
      // Ignore cache errors
    }
    return {};
  }

  static set(avatars: Record<string, AvatarConfig>): void {
    try {
      localStorage.setItem(
        this.CACHE_KEY,
        JSON.stringify({
          version: this.CACHE_VERSION,
          avatars,
          timestamp: Date.now(),
        })
      );
    } catch {
      // Ignore cache errors
    }
  }

  static getOrDefault(voiceId: string): AvatarConfig {
    const cached = this.get();
    if (cached[voiceId]) {
      return cached[voiceId];
    }
    const config = getAvatarConfig(voiceId);
    cached[voiceId] = config;
    this.set(cached);
    return config;
  }

  static clear(): void {
    try {
      localStorage.removeItem(this.CACHE_KEY);
    } catch {
      // Ignore
    }
  }
}
