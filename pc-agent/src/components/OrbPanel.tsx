import React from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import AnimatedOrb from './AnimatedOrb';
import styles from '../styles/listen.module.css';

const OrbPanel: React.FC = () => {
  const {
    listenMuted,
    setListenMuted,
    connectionStatus,
    setConnectionStatus,
    bubbles,
    lastHeardText,
    showToast,
    addBubble,
  } = useVoiceApp();

  const handleOrbClick = async () => {
    const newMutedState = !listenMuted;
    setListenMuted(newMutedState);

    if (newMutedState) {
      // Toggling TO muted - send last heard command
      const lastUserBubble = bubbles
        .filter(b => b.type === 'user')
        .at(-1)?.text || lastHeardText || '';

      if (lastUserBubble.trim()) {
        showToast(`Sending: "${lastUserBubble}"`);
        setConnectionStatus('processing');

        try {
          const res = await fetch('/voice/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: lastUserBubble,
              source: 'ui',
              userId: 'friday-ui',
            }),
          });

          const data = await res.json();
          if (data.summary) {
            addBubble({
              type: 'friday',
              text: data.summary,
              ts: Date.now(),
            });

            setConnectionStatus('listening');

            // Trigger Jarvis voice via new /voice/speak-async endpoint
            fetch('/voice/speak-async', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: data.summary }),
            }).catch(() => {});
          } else {
            setConnectionStatus('listening');
          }
        } catch (err) {
          console.error('Command failed:', err);
          showToast(`Error: ${String(err).slice(0, 50)}`, 'error');
          setConnectionStatus('listening');
        }
      } else {
        showToast('No command to send');
      }
    } else {
      // Toggling TO unmuted - resume listening
      setConnectionStatus('listening');
      showToast('Listening resumed');
      fetch('/voice/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'resume listening' }),
      }).catch(() => {});
    }
  };

  return (
    <div className={styles['orb-panel']}>
      {/* Status text */}
      <div className={styles['status-detail']} id="statusDetail">
        {connectionStatus === 'offline' && 'Waiting for voice daemon…'}
        {connectionStatus === 'listening' && 'Ready for your command.'}
        {connectionStatus === 'processing' && 'Routing to Friday agent…'}
        {connectionStatus === 'speaking' && 'Friday is responding…'}
      </div>

      {/* Animated orb */}
      <AnimatedOrb onOrbClick={handleOrbClick} />

      {/* Last heard text */}
      <div className={styles['heard-detail']} id="heardText">
        {lastHeardText || '—'}
      </div>
    </div>
  );
};

export default OrbPanel;
