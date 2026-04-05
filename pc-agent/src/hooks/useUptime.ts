import { useEffect, useState, useCallback } from 'react';

export function useUptime(onUptimeChange?: (ms: number) => void): [uptime: string, resetUptime: () => void] {
  const [startTime, setStartTime] = useState<number>(Date.now());
  const [uptimeMs, setUptimeMs] = useState<number>(0);

  const resetUptime = useCallback(() => {
    setStartTime(Date.now());
    setUptimeMs(0);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      setUptimeMs(elapsed);
      onUptimeChange?.(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime, onUptimeChange]);

  // Format uptime as HH:MM:SS
  const formatUptime = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  return [formatUptime(uptimeMs), resetUptime];
}
