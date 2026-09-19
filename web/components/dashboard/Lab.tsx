'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import BriefForm from './BriefForm';
import RunWorkspace from './RunWorkspace';
import { getConfig } from '@/lib/api';
import { useRun } from '@/lib/useRun';
import type { Config } from '@/lib/types';

export default function Lab({ runId }: { runId?: string }) {
  const router = useRouter();
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const { run, error, track, open, clear, cancel, running } = useRun();

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() => setConfigError('Could not reach the local server. Is it running on port 3000?'));
  }, []);

  useEffect(() => {
    if (runId) open(runId);
  }, [runId, open]);

  return (
    <div className="px-7 py-7 max-lg:px-4">
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-surface-100 p-5">
          {configError ? (
            <p role="alert" className="text-sm text-destructive">
              {configError}
            </p>
          ) : (
            <BriefForm
              key={run?.id ?? 'new'}
              config={config}
              disabled={running}
              initial={run?.brief}
              onStarted={(next) => {
                track(next);
                // Give the run a real URL straight away so it is shareable and
                // survives a reload, replacing the old #run= hash.
                router.replace(`/dashboard/runs/${next.id}`);
              }}
            />
          )}
        </div>

        <div className="flex flex-col gap-3">
          {error && (
            <p role="alert" className="rounded-md border border-destructive-500 bg-destructive-200 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {run ? (
            <RunWorkspace
              run={run}
              running={running}
              onCancel={cancel}
              onNew={() => {
                clear();
                router.replace('/dashboard');
              }}
            />
          ) : (
            <div className="grid min-h-[420px] place-items-center rounded-lg border border-border bg-surface-75 p-8 text-center">
              <p className="text-lg text-foreground-lighter">
                Run an experiment to get started.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
