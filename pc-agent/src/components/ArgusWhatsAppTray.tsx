import React from 'react';
import type { SpeakingPersonaKey } from '../contexts/VoiceAppContext';

export type ArgusWhatsAppTrayProps = {
  open: boolean;
  onClose: () => void;
  authHeaders: () => HeadersInit;
  theme: 'light' | 'dark';
  showToast: (message: string, type?: 'info' | 'error' | 'success') => void;
  peripheralSpeak: { channel: 'mail' | 'whatsapp'; text: string } | null;
  speakingPersonaKey: SpeakingPersonaKey;
};

/** Placeholder — Argus WhatsApp tray UI; safe no-op until wired. */
const ArgusWhatsAppTray: React.FC<ArgusWhatsAppTrayProps> = () => null;

export default ArgusWhatsAppTray;
