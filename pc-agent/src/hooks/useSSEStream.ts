import { useEffect, useRef, useCallback } from 'react';

interface SSEEvent {
  type: string;
  text?: string;
  ts?: number;
  [key: string]: any;
}

const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 12000;
const RECONNECT_FACTOR = 1.6;

export function useSSEStream(onEvent: (event: SSEEvent) => void, baseUrl = ''): void {
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_BASE);
  const callbackRef = useRef(onEvent);

  // Update callback ref to always have the latest callback
  useEffect(() => {
    callbackRef.current = onEvent;
  }, [onEvent]);

  const connectSSE = useCallback(() => {
    const streamUrl = `${baseUrl || window.location.origin}/voice/stream`;

    try {
      esRef.current = new EventSource(streamUrl);

      esRef.current.onopen = () => {
        reconnectDelayRef.current = RECONNECT_BASE;
        callbackRef.current({ type: 'sse_connected' });
      };

      esRef.current.onmessage = (event: MessageEvent) => {
        // Skip comment lines
        if (event.data.startsWith(':')) {
          return;
        }

        try {
          const data = JSON.parse(event.data);
          callbackRef.current(data);
        } catch (err) {
          console.error('Failed to parse SSE event:', err);
        }
      };

      esRef.current.onerror = () => {
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }

        callbackRef.current({ type: 'sse_disconnected' });

        // Exponential backoff
        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * RECONNECT_FACTOR,
          RECONNECT_MAX
        );

        // Schedule reconnection
        reconnectTimeoutRef.current = setTimeout(() => {
          connectSSE();
        }, reconnectDelayRef.current);
      };
    } catch (err) {
      console.error('SSE connection failed:', err);
      callbackRef.current({ type: 'sse_error', text: String(err) });
    }
  }, [baseUrl]);

  useEffect(() => {
    connectSSE();

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [connectSSE]);
}
