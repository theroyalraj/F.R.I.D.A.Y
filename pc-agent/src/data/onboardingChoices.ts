/**
 * Presets for Listen signup + company profile wizard (selection-first, still editable).
 */

export type OrgStarter = {
  id: string;
  label: string;
  name: string;
  description: string;
};

export const ORG_STARTERS: OrgStarter[] = [
  {
    id: 'personal',
    label: 'Personal / solo',
    name: 'Personal workspace',
    description: 'Individual operator using OpenClaw for voice, tasks, and automation on one machine.',
  },
  {
    id: 'startup',
    label: 'Startup / product team',
    name: '',
    description:
      'Small team shipping product fast — voice assistant for builds, reviews, and quick research.',
  },
  {
    id: 'agency',
    label: 'Agency / studio',
    name: '',
    description: 'Client-facing work — clear handoffs, deadlines, and creative delivery.',
  },
  {
    id: 'consulting',
    label: 'Consulting / advisory',
    name: '',
    description: 'Expert advice and delivery — structured briefings and follow-through.',
  },
  {
    id: 'enterprise',
    label: 'Enterprise unit',
    name: '',
    description: 'Department or squad inside a larger org — compliance-aware, documented decisions.',
  },
  {
    id: 'custom',
    label: 'Custom (type below)',
    name: '',
    description: '',
  },
];

export type TextTemplate = { id: string; label: string; text: string };

export const MISSION_TEMPLATES: TextTemplate[] = [
  {
    id: 'customer',
    label: 'Customer outcomes first',
    text: 'Deliver reliable outcomes for the people who depend on us — ship, measure, iterate.',
  },
  {
    id: 'craft',
    label: 'Craft & quality',
    text: 'Raise the bar on quality in everything we ship — thoughtful design, solid execution.',
  },
  {
    id: 'speed',
    label: 'Speed with safety',
    text: 'Move quickly without breaking trust — automate the boring, review what matters.',
  },
  {
    id: 'learn',
    label: 'Learn in public',
    text: 'Share learning, document decisions, and improve every cycle.',
  },
  {
    id: 'custom_m',
    label: 'Custom (edit below)',
    text: '',
  },
];

export const VISION_TEMPLATES: TextTemplate[] = [
  {
    id: 'assistant',
    label: 'Invisible assistant layer',
    text: 'A calm layer of assistance so humans stay focused on judgment and creativity.',
  },
  {
    id: 'scale',
    label: 'Scale without chaos',
    text: 'Grow capability without losing clarity — tools, voice, and process in sync.',
  },
  {
    id: 'trust',
    label: 'Trust by default',
    text: 'Systems people can trust — transparent, recoverable, and respectful of attention.',
  },
  {
    id: 'custom_v',
    label: 'Custom (edit below)',
    text: '',
  },
];

/** Cursor Task-style subagents (adult pool); Jarvis is main narrator — not listed here. */
export const SUBAGENT_SETUP_KEYS = [
  'dexter',
  'sage',
  'argus',
  'nova',
  'maestro',
  'harper',
  'echo',
] as const;

export type SubagentSetupKey = (typeof SUBAGENT_SETUP_KEYS)[number];

export const STORAGE_SUBAGENT_PREFERENCE = 'openclaw.setup.defaultSubagentPersona';
export const STORAGE_OPENROUTER_PREFERENCE = 'openclaw.setup.openrouterModelPreference';

export type OpenRouterSetupChoice = {
  id: string;
  label: string;
  detail: string;
  /** Server still wins until UI wires model override into pc-agent */
  disabled?: boolean;
};

export const OPENROUTER_SETUP_CHOICES: OpenRouterSetupChoice[] = [
  {
    id: 'server_default',
    label: 'Server default',
    detail: 'Use whatever the pc-agent and .env already specify (recommended today).',
  },
  {
    id: 'free_router',
    label: 'Prefer OpenRouter free router',
    detail: 'Stored for a future release — task model picker will read this from the browser.',
    disabled: true,
  },
  {
    id: 'sonnet_pref',
    label: 'Prefer balanced (Sonnet-class)',
    detail: 'Coming soon — explicit model selection from the Listen UI.',
    disabled: true,
  },
  {
    id: 'opus_pref',
    label: 'Prefer strongest (Opus-class)',
    detail: 'Coming soon — explicit model selection from the Listen UI.',
    disabled: true,
  },
];
