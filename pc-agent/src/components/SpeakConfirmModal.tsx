import React, { useEffect, useState } from 'react';
import styles from '../styles/listen.module.css';

type SpeakStyle = {
  funny: boolean;
  snarky: boolean;
  bored: boolean;
  dry: boolean;
  warm: boolean;
  customPrompt: string;
};

type Props = {
  text: string;
  voiceIcon: string;
  voiceName: string;
  speakStyle: SpeakStyle;
  onConfirm: () => void;
  onCancel: () => void;
  isOpen: boolean;
};

const SpeakConfirmModal: React.FC<Props> = ({
  text,
  voiceIcon,
  voiceName,
  speakStyle,
  onConfirm,
  onCancel,
  isOpen,
}) => {
  const [funnyMessage, setFunnyMessage] = useState('');

  useEffect(() => {
    // Generate style-aware funny message
    let msg = "About to make some noise... ";
    if (speakStyle.bored) {
      msg = "Ugh, fine, I guess I'll speak... You sure about this? ";
    } else if (speakStyle.snarky) {
      msg = "Oh, you want ME to speak? How delightful. Proceed? ";
    } else if (speakStyle.dry) {
      msg = "Speaking now. Confirm if you're ready for this. ";
    } else if (speakStyle.funny) {
      msg = "Comedy hour incoming. You ready to hear this masterpiece? ";
    } else if (speakStyle.warm) {
      msg = "Let me share this with you. Sound good? ";
    }
    setFunnyMessage(msg);
  }, [speakStyle]);

  if (!isOpen) return null;

  return (
    <div className={styles['speak-confirm-backdrop']} onClick={onCancel}>
      <div className={styles['speak-confirm-modal']} onClick={(e) => e.stopPropagation()}>
        <div className={styles['speak-confirm-header']}>
          <span className={styles['speak-confirm-icon']}>{voiceIcon}</span>
          <span className={styles['speak-confirm-title']}>Ready to speak as {voiceName}?</span>
        </div>

        <p className={styles['speak-confirm-message']}>{funnyMessage}</p>

        <div className={styles['speak-confirm-preview']}>
          <span className={styles['speak-confirm-label']}>Text to speak:</span>
          <div className={styles['speak-confirm-text']}>"{text.slice(0, 140)}{text.length > 140 ? '...' : ''}"</div>
        </div>

        <div className={styles['speak-confirm-actions']}>
          <button className={styles['speak-confirm-btn-cancel']} onClick={onCancel}>
            Nah, skip
          </button>
          <button className={styles['speak-confirm-btn-confirm']} onClick={onConfirm}>
            Let's do it 🔊
          </button>
        </div>
      </div>
    </div>
  );
};

export default SpeakConfirmModal;
