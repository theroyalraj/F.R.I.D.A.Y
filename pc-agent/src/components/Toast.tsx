import React, { useRef, useEffect } from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import styles from '../styles/listen.module.css';

// Icon map for different toast types
const TOAST_ICONS: Record<string, string> = {
  success: '✓',
  error: '⚠',
  info: 'ℹ',
  warning: '⚡',
};

const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useVoiceApp();
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Auto-dismiss toasts based on type
  useEffect(() => {
    toasts.forEach(toast => {
      if (!timeoutsRef.current.has(toast.id)) {
        const duration = toast.type === 'error' ? 4000 : 2800;
        const timeout = setTimeout(() => {
          dismissToast(toast.id);
          timeoutsRef.current.delete(toast.id);
        }, duration);
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
          aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
        >
          <div className={styles['toast-content']}>
            <span className={styles['toast-icon']}>
              {TOAST_ICONS[toast.type] || 'ℹ'}
            </span>
            <span className={styles['toast-message']}>{toast.message}</span>
          </div>
          <button
            className={styles['toast-close']}
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastContainer;
