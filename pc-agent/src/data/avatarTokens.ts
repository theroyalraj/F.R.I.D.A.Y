import type { CSSProperties } from 'react';

/**
 * Single source of truth for listen UI avatar pixel sizes.
 * Injected on `.app` as CSS variables (see `ocAvatarCssVars`).
 */
export const OC_AVATAR_PX = {
  chat: 26,
  chatLg: 40,
  voiceSmall: 32,
  voiceMedium: 48,
  voiceLarge: 72,
  animatedSmall: 48,
  animatedMedium: 72,
  animatedLarge: 120,
  /** Sidebar “big avatar” hero */
  animatedHero: 168,
  /** Full-screen lightbox */
  animatedZoom: 280,
  celebration: 40,
} as const;

/** CSS custom properties for `listen.module.css` (descendants of `.app`). */
export function ocAvatarCssVars(): CSSProperties {
  const a = OC_AVATAR_PX;
  return {
    '--oc-avatar-chat': `${a.chat}px`,
    '--oc-avatar-voice-sm': `${a.voiceSmall}px`,
    '--oc-avatar-voice-md': `${a.voiceMedium}px`,
    '--oc-avatar-voice-lg': `${a.voiceLarge}px`,
    '--oc-avatar-animated-lg': `${a.animatedLarge}px`,
    '--oc-avatar-animated-hero': `${a.animatedHero}px`,
    '--oc-avatar-animated-zoom': `${a.animatedZoom}px`,
    '--oc-avatar-chat-lg': `${a.chatLg}px`,
    '--oc-avatar-celebration': `${a.celebration}px`,
  } as CSSProperties;
}
