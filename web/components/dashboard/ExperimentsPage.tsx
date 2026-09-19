'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SlideOver } from '@/components/ui/slide-over';
import BriefForm from './BriefForm';
import { errorMessage, getConfig, listRuns } from '@/lib/api';
import type { Brief, Config, RunSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<string, string> = {
  running: 'border-brand-400 text-brand',
  completed: 'border-border text-foreground-light',
  cancelled: 'border-border text-foreground-lighter',
  failed: 'border-destructive-500 text-destructive',
};

/** The primary surface: the list of runs. Creating one is transient work that
 *  happens in a panel, so it never occupies the layout permanently. */
export default function ExperimentsPage({ duplicateOf }: { duplicateOf?: Brief | null }) {
  const router = useRouter();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(!!duplicateOf);

  const load = useCallback(() => {
    listRuns()
      .then(setRuns)
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  useEffect(() => {
    load();
    getConfig().then(setConfig).catch(() => {});
  }, [load]);

  const active = runs?.some((run) => run.status === 'running') ?? false;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-6 py-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl text-foreground">Experiments</h1>
          <p className="text-sm text-foreground-lighter">
            Every run is saved on this computer, under <code>data/</code>.
          </p>
        </div>
        <Button type="button" variant="primary" onClick={() => setPanelOpen(true)}>
          <Plus size={15} /> New experiment
        </Button>
      </div>

      <div className="px-6 py-6">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive-500 bg-destructive-200 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {runs === null && !error && (
          <p className="text-sm text-foreground-lighter">Loading…</p>
        )}

        {runs?.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
            <h2 className="text-lg text-foreground">No experiments yet</h2>
            <p className="max-w-[46ch] text-sm text-foreground-lighter">
              Describe a product and Evolve will generate a population of ad concepts,
              screen them, then recombine the survivors across generations.
            </p>
            <Button
              type="button"
              variant="primary"
              className="mt-1"
              onClick={() => setPanelOpen(true)}
            >
              <Plus size={15} /> New experiment
            </Button>
          </div>
        )}

        {runs && runs.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border bg-surface-100">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-border px-4 py-2">
              <span className="label">Product</span>
              <span className="label text-right">Generated</span>
              <span className="label text-right">Status</span>
            </div>
            <ul className="flex flex-col divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/dashboard/runs/${run.id}`}
                    className="focus-ring grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-200"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm text-foreground">{run.product}</span>
                      <span className="text-xs text-foreground-lighter">
                        {new Date(run.createdAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="text-right text-sm tabular-nums text-foreground-light">
                      {run.metrics.generated}
                    </span>
                    <span
                      className={cn(
                        'w-24 shrink-0 rounded border px-1.5 py-0.5 text-center text-[10px] uppercase tracking-wider',
                        STATUS_STYLE[run.status] ?? 'border-border text-foreground-lighter'
                      )}
                    >
                      {run.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <SlideOver
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title="New experiment"
        description={
          active
            ? 'A run is already in progress. Two can run at once.'
            : 'Describe the product. Evolve does the rest.'
        }
      >
        <BriefForm
          config={config}
          disabled={false}
          initial={duplicateOf}
          onStarted={(run) => {
            setPanelOpen(false);
            router.push(`/dashboard/runs/${run.id}`);
          }}
        />
      </SlideOver>
    </div>
  );
}
