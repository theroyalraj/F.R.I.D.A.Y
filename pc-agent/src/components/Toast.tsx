import React, { useRef, useEffect } from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import styles from '../styles/listen.module.css';

const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useVoiceApp();
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Auto-dismiss toasts
  useEffect(() => {
    toasts.forEach(toast => {
      if (!timeoutsRef.current.has(toast.id)) {
        const timeout = setTimeout(() => {
          dismissToast(toast.id);
          timeoutsRef.current.delete(toast.id);
        }, 2800);
        timeoutsRef.current.set(toast.id, timeout);
      }
    });

    return () => {
      // Clean up timeouts for removed toasts
      timeoutsRef.current.forEach(timeout => clearTimeout(timeout));
    };
  }, [toasts, dismissToast]);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className={styles['toast-container']}>
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`${styles['voice-toast']} ${styles[`toast-${toast.type}`]}`}
          role="status"
          aria-live="polite"
        >
          <span>{toast.message}</span>
          <button
            className={styles['toast-close']}
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastContainer;
