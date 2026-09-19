'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { errorMessage, listRuns } from '@/lib/api';
import type { RunSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<string, string> = {
  running: 'border-brand-400 text-brand',
  completed: 'border-border text-foreground-light',
  cancelled: 'border-border text-foreground-lighter',
  failed: 'border-destructive-500 text-destructive',
};

export default function RunsList() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns()
      .then(setRuns)
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  return (
    <div className="px-7 py-7 max-lg:px-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <div className="flex flex-col gap-1">
          <span className="label">Saved experiments</span>
          <h1 className="text-3xl text-foreground">Your creative explorations</h1>
          <p className="text-sm text-foreground-lighter">
            Runs are saved on this computer, under <code>data/</code>.
          </p>
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-destructive-500 bg-destructive-200 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {runs === null && !error && <p className="text-sm text-foreground-lighter">Loading…</p>}

        {runs?.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-5 py-12 text-center">
            <p className="text-sm text-foreground-lighter">
              Run your first experiment to start a creative history.
            </p>
            <Link
              href="/dashboard"
              className="focus-ring mt-3 inline-block rounded-md text-sm text-brand-link hover:underline"
            >
              Open the lab
            </Link>
          </div>
        )}

        {runs && runs.length > 0 && (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-100">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/dashboard/runs/${run.id}`}
                  className="focus-ring flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-200"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm text-foreground">{run.product}</span>
                    <span className="text-xs text-foreground-lighter">
                      {new Date(run.createdAt).toLocaleString()} · {run.metrics.generated} generated
                    </span>
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
                      STATUS_STYLE[run.status] ?? 'border-border text-foreground-lighter'
                    )}
                  >
                    {run.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
