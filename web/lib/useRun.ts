'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelRun, errorMessage, getRun } from './api';
import type { Run } from './types';

const POLL_MS = 700;

// 'cancelling' is only ever the cancel endpoint's response field (server.mjs:101);
// the run itself is only running/completed/cancelled/failed.
export const isRunning = (run: Run | null) => run?.status === 'running';

/**
 * Polls a run while it is active.
 *
 * The sequence counter is load-bearing, not defensive dressing: switching runs or
 * starting a new one while a poll is in flight would otherwise let the stale
 * response land after the switch and overwrite current state. Every fetch
 * snapshots the counter and drops its own result if the counter moved.
 */
export function useRun() {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    sequence.current += 1;
  }, []);

  const poll = useCallback(
    async (id: string) => {
      const ticket = sequence.current;
      try {
        const next = await getRun(id);
        if (ticket !== sequence.current) return;
        setRun(next);
        if (next.status === 'running') {
          timer.current = setTimeout(() => poll(id), POLL_MS);
        }
      } catch (caught) {
        if (ticket !== sequence.current) return;
        // A transient poll failure should not abandon a live run; keep polling
        // and let the message show until the next tick succeeds.
        setError(errorMessage(caught));
        timer.current = setTimeout(() => poll(id), POLL_MS);
      }
    },
    []
  );

  const track = useCallback(
    (next: Run) => {
      stop();
      setError(null);
      setRun(next);
      if (next.status === 'running') {
        timer.current = setTimeout(() => poll(next.id), POLL_MS);
      }
    },
    [poll, stop]
  );

  const open = useCallback(
    async (id: string) => {
      stop();
      setError(null);
      try {
        const next = await getRun(id);
        track(next);
        return next;
      } catch (caught) {
        setError(errorMessage(caught));
        return null;
      }
    },
    [stop, track]
  );

  const clear = useCallback(() => {
    stop();
    setRun(null);
    setError(null);
  }, [stop]);

  const cancel = useCallback(async () => {
    if (!run) return;
    try {
      await cancelRun(run.id);
      await poll(run.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [poll, run]);

  useEffect(() => stop, [stop]);

  return { run, error, setError, track, open, clear, cancel, running: isRunning(run) };
}
