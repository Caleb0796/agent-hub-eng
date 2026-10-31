import { useEffect, useRef } from 'react';

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
