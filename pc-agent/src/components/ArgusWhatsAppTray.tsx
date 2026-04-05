import React from 'react';
import SecurityScanPanel from './SecurityScanPanel';
import WhatsAppPanel from './WhatsAppPanel';
import type { SpeakingPersonaKey } from '../contexts/VoiceAppContext';
import styles from '../styles/listen.module.css';

type Props = {
  open: boolean;
  onClose: () => void;
  authHeaders: () => HeadersInit;
  theme: 'light' | 'dark';
  showToast: (message: string, variant?: 'info' | 'success' | 'error') => void;
  peripheralSpeak: { channel: 'mail' | 'whatsapp'; text: string } | null;
  speakingPersonaKey: SpeakingPersonaKey;
};

/**
 * Left slide tray: Argus (npm audit + static code pattern scan) + WhatsApp. All “police” UI lives here only.
 */
const ArgusWhatsAppTray: React.FC<Props> = ({
  open,
  onClose,
  authHeaders,
  theme,
  showToast,
  peripheralSpeak,
  speakingPersonaKey,
}) => {
  return (
    <>
      {open ? (
        <button
          type="button"
          className={styles['side-tray-backdrop']}
          onClick={onClose}
          aria-label="Close Argus and WhatsApp tray"
        />
      ) : null}
      <aside
        className={[
          styles['side-tray-left'],
          theme === 'light' ? styles['side-tray-left-light'] : '',
          open ? styles['side-tray-left-open'] : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden={!open}
        aria-label="Argus and WhatsApp"
      >
        <div className={styles['side-tray-left-inner']}>
          <div className={styles['side-tray-left-head']}>
            <span className={styles['side-tray-left-title']}>Argus and WhatsApp</span>
            <button type="button" className={styles['side-tray-left-close']} onClick={onClose} aria-label="Close tray">
              {'\u2715'}
            </button>
          </div>
          <div className={styles['side-tray-left-scroll']}>
            <div className={styles['side-tray-section']}>
              <SecurityScanPanel
                authHeaders={authHeaders}
                theme={theme}
                showToast={showToast}
                variant="panel"
              />
            </div>
            <div className={styles['side-tray-section']}>
              <WhatsAppPanel
                authHeaders={authHeaders}
                showToast={showToast}
                peripheralSpeak={peripheralSpeak}
                speakingPersonaKey={speakingPersonaKey}
              />
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};

export default ArgusWhatsAppTray;
