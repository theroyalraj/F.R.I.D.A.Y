import React, { useCallback, useEffect, useState } from 'react';
import { safeReadJson } from '../lib/fetchJson';
import type { SpeakingPersonaKey } from '../contexts/VoiceAppContext';
import { COMPANY_PERSONAS, personaIcon, type CompanyPersonaKey } from '../data/companyPersonas';
import styles from '../styles/listen.module.css';

type WaMsg = { id: string; from: string; text: string; ts: string };

type WaStatus = {
  connectionStatus: string | null;
  state: string | null;
  number: string | null;
  profileName: string | null;
  error: string | null;
  loading: boolean;
};

const POLL_MS = 32_000;

type Props = {
  authHeaders: () => HeadersInit;
  showToast: (message: string, variant?: 'info' | 'success' | 'error') => void;
  peripheralSpeak: { channel: 'mail' | 'whatsapp'; text: string } | null;
  speakingPersonaKey: SpeakingPersonaKey;
};

/**
 * WhatsApp status, recent inbound, compose — used inside ArgusWhatsAppTray (left side tray).
 */
const WhatsAppPanel: React.FC<Props> = ({
  authHeaders,
  showToast,
  peripheralSpeak,
  speakingPersonaKey,
}) => {
  const [waStatus, setWaStatus] = useState<WaStatus>({
    connectionStatus: null,
    state: null,
    number: null,
    profileName: null,
    error: null,
    loading: true,
  });
  const [waMessages, setWaMessages] = useState<WaMsg[]>([]);
  const [waMsgError, setWaMsgError] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState('');
  const [waText, setWaText] = useState('');
  const [waSending, setWaSending] = useState(false);

  const refreshWhatsApp = useCallback(async () => {
    try {
      const [metaR, stR, msgR] = await Promise.all([
        fetch('/integrations/whatsapp/meta', { headers: authHeaders() }),
        fetch('/integrations/whatsapp/status', { headers: authHeaders() }),
        fetch('/integrations/whatsapp/messages?limit=12', { headers: authHeaders() }),
      ]);
      const { data: metaRaw } = await safeReadJson(metaR);
      const meta = metaRaw as { defaultNumber?: string };
      if (metaR.ok && meta?.defaultNumber) {
        setWaNumber((n) => n || String(meta.defaultNumber));
      }

      const { data: stRaw } = await safeReadJson(stR);
      const st = stRaw as {
        error?: string;
        connectionStatus?: string | null;
        state?: string | null;
        number?: string | null;
      };
      if (!stR.ok) {
        setWaStatus({
          connectionStatus: null,
          state: null,
          number: null,
          profileName: null,
          error: st?.error || `HTTP ${stR.status}`,
          loading: false,
        });
      } else {
        const stFull = stRaw as typeof st & { profileName?: string | null };
        setWaStatus({
          connectionStatus: stFull.connectionStatus ?? null,
          state: stFull.state ?? null,
          number: stFull.number ?? null,
          profileName: stFull.profileName ?? null,
          error: null,
          loading: false,
        });
      }

      const { data: mjRaw } = await safeReadJson(msgR);
      const mj = mjRaw as { messages?: WaMsg[]; error?: string };
      if (msgR.ok && Array.isArray(mj.messages)) {
        setWaMessages(mj.messages);
        setWaMsgError(null);
      } else {
        setWaMsgError(mj.error || `messages HTTP ${msgR.status}`);
        setWaMessages([]);
      }
    } catch (e) {
      setWaStatus((s) => ({
        ...s,
        loading: false,
        error: String((e as Error).message || e),
      }));
      setWaMsgError(String((e as Error).message || e));
    }
  }, [authHeaders]);

  useEffect(() => {
    void refreshWhatsApp();
  }, [refreshWhatsApp]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) void refreshWhatsApp();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshWhatsApp]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return;
      void refreshWhatsApp();
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [refreshWhatsApp]);

  const connectionOk =
    waStatus.connectionStatus === 'open' ||
    String(waStatus.state || '').toLowerCase() === 'open';

  const waSpeaking = peripheralSpeak?.channel === 'whatsapp';
  const speakPersona =
    speakingPersonaKey && speakingPersonaKey !== 'custom'
      ? COMPANY_PERSONAS[speakingPersonaKey]
      : null;

  const handleSendWa = async () => {
    const num = waNumber.replace(/\D/g, '');
    const text = waText.trim();
    if (!num || !text) {
      showToast('Enter number and message', 'error');
      return;
    }
    setWaSending(true);
    try {
      const r = await fetch('/integrations/whatsapp/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number: num, text }),
      });
      const d = await r.json();
      if (!r.ok) {
        showToast(d.error || `Send failed (${r.status})`, 'error');
      } else {
        showToast('WhatsApp message sent', 'success');
        setWaText('');
        void refreshWhatsApp();
      }
    } catch (e) {
      showToast(String((e as Error).message || e), 'error');
    } finally {
      setWaSending(false);
    }
  };

  return (
    <div
      className={`${styles['integrations-section']} ${waSpeaking ? styles['integrations-section-speaking'] : ''}`}
    >
      <div className={styles['integrations-section-head']}>
        <span className={styles['integrations-title']}>WhatsApp</span>
        <span
          className={`${styles['integrations-wa-pill']} ${connectionOk ? styles['integrations-wa-ok'] : styles['integrations-wa-bad']}`}
        >
          {waStatus.loading ? '…' : waStatus.connectionStatus || waStatus.state || 'unknown'}
        </span>
        <button
          type="button"
          className={styles['integrations-refresh']}
          onClick={() => void refreshWhatsApp()}
          disabled={waStatus.loading}
        >
          Refresh
        </button>
      </div>
      {waStatus.error && <div className={styles['integrations-error']}>{waStatus.error}</div>}
      {waSpeaking && (
        <div className={styles['integrations-speak-banner']} role="status" aria-live="polite">
          {speakPersona ? (
            <span className={styles['integrations-speak-who']}>
              <span className={styles['integrations-speak-icon']}>
                {personaIcon(speakingPersonaKey as CompanyPersonaKey)}
              </span>
              <span>
                {speakPersona.name} · speaking
              </span>
            </span>
          ) : (
            <span>Speaking…</span>
          )}
          <span className={styles['integrations-speak-snippet']}>
            {peripheralSpeak!.text.length > 140 ? `${peripheralSpeak!.text.slice(0, 137)}…` : peripheralSpeak!.text}
          </span>
        </div>
      )}
      {(waStatus.profileName || waStatus.number) && (
        <div className={styles['integrations-muted']}>
          {waStatus.profileName ? `${waStatus.profileName} · ` : ''}
          {waStatus.number || ''}
        </div>
      )}
      <div className={styles['integrations-wa-msgs']}>
        <div className={styles['integrations-list-label']}>Recent inbound</div>
        {waMsgError && <div className={styles['integrations-error']}>{waMsgError}</div>}
        {waMessages.length === 0 && !waMsgError && (
          <div className={styles['integrations-muted']}>No messages yet</div>
        )}
        {waMessages.map((msg) => (
          <div key={msg.id} className={styles['integrations-wa-line']}>
            <span className={styles['integrations-wa-from']}>+{msg.from}</span>
            <span className={styles['integrations-wa-text']}>{msg.text}</span>
          </div>
        ))}
      </div>
      <div className={styles['integrations-wa-compose']}>
        <input
          type="text"
          className={styles['integrations-input']}
          placeholder="Number (digits)"
          value={waNumber}
          onChange={(e) => setWaNumber(e.target.value)}
          aria-label="WhatsApp number"
        />
        <textarea
          className={styles['integrations-textarea']}
          placeholder="Message (allowlisted numbers only)"
          value={waText}
          onChange={(e) => setWaText(e.target.value)}
          rows={3}
          aria-label="WhatsApp message text"
        />
        <button
          type="button"
          className={styles['integrations-send-wa']}
          onClick={() => void handleSendWa()}
          disabled={waSending || !connectionOk}
        >
          {waSending ? 'Sending…' : 'Send'}
        </button>
        {!connectionOk && (
          <div className={styles['integrations-muted']}>
            Connect WhatsApp in Evolution to send from here
          </div>
        )}
      </div>
    </div>
  );
};

export default WhatsAppPanel;
