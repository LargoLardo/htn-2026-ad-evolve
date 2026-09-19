'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SlideOver } from '@/components/ui/slide-over';
import BriefForm from './BriefForm';
import RunWorkspace from './RunWorkspace';
import { getConfig } from '@/lib/api';
import { useRun } from '@/lib/useRun';
import { EMOTIONS, type Config } from '@/lib/types';

export default function RunView({ runId }: { runId: string }) {
  const router = useRouter();
  const { run, error, open, cancel, running } = useRun();
  const [config, setConfig] = useState<Config | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  useEffect(() => {
    open(runId);
  }, [runId, open]);

  useEffect(() => {
    getConfig().then(setConfig).catch(() => {});
  }, []);

  if (error && !run) {
    return (
      <div className="px-6 py-6">
        <p
          role="alert"
          className="rounded-md border border-destructive-500 bg-destructive-200 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      </div>
    );
  }

  if (!run) {
    return <p className="px-6 py-6 text-sm text-foreground-lighter">Loading experiment…</p>;
  }

  const brief = run.brief;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl text-foreground">{brief.product}</h1>
          <p className="max-w-[80ch] text-sm text-foreground-lighter">{brief.description}</p>
        </div>
        <Button type="button" onClick={() => setDuplicating(true)}>
          <Copy size={14} /> Duplicate
        </Button>
      </div>

      <div className="flex flex-col gap-4 px-6 py-6">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive-500 bg-destructive-200 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <RunWorkspace
          run={run}
          running={running}
          onCancel={cancel}
        />

        {/* The brief is settled history for this run, so it reads rather than
            edits. Changing it means starting a new run, which is Duplicate. */}
        <details className="group rounded-lg border border-border bg-surface-100">
          <summary className="focus-ring flex cursor-pointer list-none items-center justify-between px-5 py-3 text-sm text-foreground-light">
            Brief and settings
            <span className="transition-transform group-open:rotate-45">+</span>
          </summary>
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-border px-5 py-4 md:grid-cols-3">
            <Field label="Audience" value={brief.audience} />
            <Field label="Goal" value={brief.goal} />
            <Field
              label="Emotional priorities"
              value={EMOTIONS.map((e) => `${e} ${brief.weights[e]}`).join(', ')}
            />
            <Field
              label="Budget"
              value={`${brief.rounds} rounds, ${brief.population} per round, shortlist ${brief.shortlist}`}
            />
            <Field label="Ad format" value={brief.mediaType === 'video' ? `Video · ${brief.videoDuration}s · ${brief.aspectRatio}` : 'Image'} />
            <Field label="Mode" value={`${brief.mode} generation, ${brief.scorer} scoring`} />
            <Field label="Seed" value={String(brief.seed)} />
          </div>
        </details>
      </div>

      <SlideOver
        open={duplicating}
        onClose={() => setDuplicating(false)}
        title="Duplicate experiment"
        description="Prefilled from this run. Change anything before starting."
      >
        <BriefForm
          config={config}
          disabled={false}
          initial={brief}
          onStarted={(next) => {
            setDuplicating(false);
            router.push(`/dashboard/runs/${next.id}`);
          }}
        />
      </SlideOver>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <span className="text-sm text-foreground-light">{value || '-'}</span>
    </div>
  );
}
