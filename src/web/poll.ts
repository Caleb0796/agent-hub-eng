import { useEffect, useRef } from 'react';
import { api } from './api';

const WATCH_RETRY_MS = 3000;

/**
 * Runs `task` now and then every `ms` after the previous run finishes, so slow responses never
 * pile up. A hidden tab stops polling and catches up as soon as it is visible again.
 */
export function usePoll(task: () => Promise<unknown>, ms: number, enabled = true): void {
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false,
      running = false;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || running || document.hidden) return;
      running = true;
      await latest.current().catch(() => undefined);
      running = false;
      if (!stopped) timer = setTimeout(() => void tick(), ms);
    };
    const onVisible = () => void tick();
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms, enabled]);
}

/**
 * Asks the server to answer when `url` has a new version, then calls `onChange`. Requests stay
 * open while nothing happens, so changes show up at once. A hidden tab stops asking.
 */
export function useWatch(url: string, onChange: () => Promise<unknown>): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    let stopped = false,
      version = '',
      running = false;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const loop = async () => {
      if (running) return;
      running = true;
      while (!stopped && !document.hidden) {
        try {
          const next = await api<{ v: string }>(`${url}?v=${encodeURIComponent(version)}`);
          if (stopped) break;
          if (next.v !== version) {
            if (version) await latest.current().catch(() => undefined);
            version = next.v;
          }
        } catch {
          await pause(WATCH_RETRY_MS);
        }
      }
      running = false;
    };
    const onVisible = () => void loop();
    document.addEventListener('visibilitychange', onVisible);
    void loop();
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [url]);
}
