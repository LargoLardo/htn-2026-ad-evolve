'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Download } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import CreativeInspector from './CreativeInspector';
import RoundGate from './RoundGate';
import LineageTree from './LineageTree';
import { assetLink, exportHref, safeLink } from '@/lib/api';
import { type Candidate, type Run, type RunStage } from '@/lib/types';
import MediaPreview from './MediaPreview';
import { compareCandidates, isNeural, scoreDisplay, selectionScore } from '@/lib/scores';
import { cn } from '@/lib/utils';

const STAGE_TEXT: Record<RunStage, string> = {
  queued: 'Queued.',
  research: 'Researching the brief…',
  generating: 'Generating creative traits…',
  screening: 'Reviewing media, copy and claims…',
  rendering: 'Rendering the shortlist…',
  scoring: 'Scoring rendered candidates…',
  evolving: 'Recombining and mutating…',
  'awaiting-selection': 'Choose the parents for the next round.',
  finalizing: 'Selecting finalists…',
  complete: 'Run complete.',
  cancelled: 'Run cancelled.',
  failed: 'Run failed.',
};

const TABS = ['lineage', 'brain', 'maps', 'research', 'log'] as const;
type Tab = (typeof TABS)[number];

// The maps tab fetches a precomputed artifact, so it is not worth loading until
// someone opens it.
const MapsView = dynamic(() => import('@/components/maps/MapsView'), {
  ssr: false,
  loading: () => (
    <div className="rounded-lg border border-dashed border-border px-5 py-10 text-center text-sm text-foreground-lighter">
      Loading the maps…
    </div>
  ),
});

// WebGL and the mesh binaries are only worth loading if this tab is opened, and
// the canvas cannot be server-rendered.
const BrainView = dynamic(() => import('@/components/brain/BrainView'), {
  ssr: false,
  loading: () => (
    <div className="rounded-lg border border-dashed border-border px-5 py-10 text-center text-sm text-foreground-lighter">
      Loading the cortical surface…
    </div>
  ),
});

const score = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '-';

const clamp = (value?: number | null) =>
  Math.min(100, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0));

// Keep short cached runs readable without rounding away their duration.
// Runs are minutes long, not seconds: a single scoring pass alone is about two
// minutes. Reporting 1520.5s for a 25 minute run is accurate and unreadable,
// so past a minute this switches to minutes and past an hour to hours.
const elapsed = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)} min`;
  return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
};

export default function RunWorkspace({
  run,
  running,
  onCancel,
}: {
  run: Run;
  running: boolean;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<Tab>('lineage');
  const [inspecting, setInspecting] = useState<Candidate | null>(null);

  // The server writes metrics at stage boundaries, so elapsedMs sits still for
  // the whole of a scoring call, which is about two minutes. A timer that
  // freezes for two minutes reads as a hung run, so while a run is live this
  // counts from its start time instead and only defers to the recorded figure
  // once the run is over and that figure is final.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // metrics.elapsedMs is only written when a stage changes, so on a finished
  // run it stops at the last stage boundary rather than at the end, and while
  // one is live it sits still for the two minutes a scoring pass takes. Both
  // under-report. The event log has real timestamps, so measure the span that
  // actually happened and fall back to the recorded figure only when there is
  // nothing to measure.
  const elapsedMs = useMemo(() => {
    const started = new Date(run.createdAt).getTime();
    if (running) return Math.max(run.metrics.elapsedMs, now - started);
    const last = run.events?.at(-1)?.time;
    const measured = last ? new Date(last).getTime() - started : 0;
    return Number.isFinite(measured) && measured > 0 ? measured : run.metrics.elapsedMs;
  }, [running, now, run.createdAt, run.events, run.metrics.elapsedMs]);

  const allCandidates = useMemo(
    () => run.rounds.flatMap((round) => round.candidates),
    [run.rounds]
  );

  const progress = Math.min(96, 5 + (run.rounds.length / Math.max(1, run.brief.rounds)) * 85);

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border bg-surface-100">
        {/* The product name and the Duplicate action belong to the page header
            above this, so the banner carries only live state and run actions. */}
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-2.5">
            {running && (
              <span
                aria-hidden
                className="size-2 shrink-0 animate-pulse rounded-full bg-brand"
              />
            )}
            <p role="status" aria-live="polite" className="text-sm text-foreground-light">
              {run.error ?? STAGE_TEXT[run.stage] ?? run.stage}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <Button type="button" size="small" onClick={onCancel}>
                Stop run
              </Button>
            ) : (
              <ButtonLink href={exportHref(run.id)} size="small" download prefetch={false}>
                <Download size={14} /> Export run
              </ButtonLink>
            )}
          </div>
        </div>

        <div className="h-0.5 w-full bg-border-muted">
          <div
            className="h-full bg-brand transition-[width] duration-500"
            style={{ width: `${running ? progress : 100}%` }}
          />
        </div>

        <dl className="grid grid-cols-2 divide-border border-t border-border sm:grid-cols-4 sm:divide-x">
          {[
            ['Generated', run.metrics.generated],
            ['Rendered', run.metrics.rendered],
            ...(run.metrics.reviewed > 0
              ? ([['Reviewed', `${run.metrics.reviewed - run.metrics.rejected}/${run.metrics.reviewed}`]] as [string, string][])
              : ([['Cache hits', run.metrics.cacheHits]] as [string, number][])),
            ['Elapsed', elapsed(elapsedMs)],
          ].map(([label, value]) => (
            <div key={label as string} className="flex flex-col gap-0.5 p-4">
              <dt className="label">{label as string}</dt>
              <dd className="text-2xl tabular-nums text-foreground">{value as string}</dd>
            </div>
          ))}
        </dl>
      </div>

      {run.gate && run.gate.status !== 'resolved' && running && <RoundGate key={run.gate.token} run={run} gate={run.gate} />}

      <p className="rounded-md border border-border-muted bg-surface-75 px-3 py-2 text-xs text-foreground-lighter">
        {isNeural(run) ? 'Neural overall / 100: four equally weighted Glasser families, normalized against one original creative, where 50 is parity with it. This is the magnitude of the predicted cortical response, and selection currently takes the largest. A larger response is not evidence of a better ad: a cluttered original with a wall of body text scores highly because it is taxing to read. Predicted response only, not measured emotion, engagement or conversions.' : 'Historical run: these recorded scores use an earlier method.'}
        {run.requiresReview && ' Some finalists have copy differences or other media-review issues. Inspect their reviews before use.'}
      </p>

      <div className="flex flex-wrap items-center gap-1 border-b border-border" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              'focus-ring -mb-px border-b-2 px-3 py-2 text-sm capitalize transition-colors',
              tab === name
                ? 'border-brand text-foreground'
                : 'border-transparent text-foreground-lighter hover:text-foreground'
            )}
          >
            {name}
          </button>
        ))}
        <span className="ml-auto text-xs uppercase tracking-wider text-foreground-lighter">
          {run.status}{run.requiresReview ? ' · needs review' : ''}
        </span>
      </div>

      {/* One tab, not two. The tree already shows every candidate with its
          score and opens the same inspector on click, so a parallel grid of the
          same creatives filtered by generation was a second answer to a
          question the tree answers better: it shows WHICH parent each one came
          from, which the grid could never say. */}
      {tab === 'lineage' && (
        <>
          {allCandidates.length === 0 ? (
            <Waiting running={running} text="No candidates yet." />
          ) : (
            <LineageTree run={run} onInspect={setInspecting} />
          )}
          <FitnessChart run={run} />
        </>
      )}

      {tab === 'brain' && <BrainView run={run} />}

      {tab === 'maps' && <MapsView run={run} />}

      {tab === 'research' && (
        <div className="flex flex-col gap-4">
          {run.research ? (
            <>
              <p className="text-sm text-foreground-light">{run.research.summary}</p>
              {run.research.insights.map((insight, index) => (
                <article key={index} className="grid grid-cols-[28px_1fr] gap-3">
                  <span className="text-xs tabular-nums text-foreground-muted">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base text-foreground">{insight.title}</h3>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground-lighter">
                        {insight.kind}
                      </span>
                    </div>
                    <p className="text-sm text-foreground-lighter">{insight.detail}</p>
                    <ul className="flex flex-col gap-0.5">
                      {insight.sourceUrls.map(safeLink).filter(Boolean).map((href) => (
                        <li key={href as string}>
                          <a
                            href={href as string}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-brand-link underline-offset-2 hover:underline"
                          >
                            {href as string}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                </article>
              ))}
              <p className="text-xs text-foreground-lighter">{run.research.provenance}</p>
            </>
          ) : (
            <Waiting running={running} text="Research has not run yet." />
          )}
        </div>
      )}

      {tab === 'log' && (
        <ul className="flex flex-col divide-y divide-border-muted border-y border-border-muted">
          {run.events.map((event, index) => (
            <li key={index} className="flex gap-3 py-1.5 text-xs">
              <time className="shrink-0 tabular-nums text-foreground-muted">
                {new Date(event.time).toLocaleTimeString()}
              </time>
              <span className="text-foreground-light">{event.message}</span>
            </li>
          ))}
        </ul>
      )}

      <CreativeInspector
        candidate={allCandidates.find(c => c.id === inspecting?.id) ?? inspecting}
        product={run.brief.product}
        originalLabel={allCandidates.find(c => c.id === run.neuralBaseline?.candidateId)?.headline}
        onClose={() => setInspecting(null)}
      />
    </div>
  );
}

function Waiting({ running, text }: { running: boolean; text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-5 py-10 text-center text-sm text-foreground-lighter">
      {running ? 'Working…' : text}
    </div>
  );
}

/** Hand-rolled percentage bars, as in the original: the score domain is a fixed
 *  0-100, so a chart library would add a dependency for two divs. */
function FitnessChart({ run }: { run: Run }) {
  const rounds = run.rounds.filter((round) => Number.isFinite(round.best));
  if (rounds.length < 2) return null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-100 p-5">
      <h3 className="label">{isNeural(run) ? 'Neural score by round' : 'Historical scores by round'}</h3>
      {/* Capped rather than flex-1: at full dashboard width, one bar per
          generation stretched into wide slabs that read as blocks, not a chart. */}
      <div className="flex items-end gap-6">
        {rounds.map((round) => (
          <div key={round.number} className="flex w-16 flex-col items-center gap-2">
            <div className="flex h-32 w-full items-end justify-center gap-1.5">
              <div
                className="w-5 rounded-t bg-brand transition-[height] duration-500"
                style={{ height: `${clamp(round.best)}%` }}
                title={`Best ${score(round.best)}`}
              />
              <div
                className="w-5 rounded-t bg-border-stronger transition-[height] duration-500"
                style={{ height: `${clamp(round.mean)}%` }}
                title={`Mean ${score(round.mean)}`}
              />
            </div>
            <span className="text-[10px] text-foreground-lighter">Round {round.number}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-4 text-[10px] text-foreground-lighter">
        <span className="flex items-center gap-1.5">
          <i className="size-2 rounded-sm bg-brand" /> Best
        </span>
        <span className="flex items-center gap-1.5">
          <i className="size-2 rounded-sm bg-border-stronger" /> Mean
        </span>
      </div>
    </section>
  );
}
