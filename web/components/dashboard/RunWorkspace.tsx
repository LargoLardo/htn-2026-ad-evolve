'use client';

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import CreativeInspector from './CreativeInspector';
import { assetLink, exportHref, safeLink } from '@/lib/api';
import { type Candidate, type Run, type RunStage } from '@/lib/types';
import MediaPreview from './MediaPreview';
import { compareCandidates, isPercept, scoreLabel, selectionScore } from '@/lib/scores';
import { cn } from '@/lib/utils';

const STAGE_TEXT: Record<RunStage, string> = {
  queued: 'Queued.',
  research: 'Researching the brief…',
  generating: 'Generating creative genomes…',
  screening: 'Reviewing media, copy and claims…',
  rendering: 'Rendering the shortlist…',
  scoring: 'Scoring rendered candidates…',
  evolving: 'Recombining and mutating…',
  finalizing: 'Selecting finalists…',
  complete: 'Run complete.',
  cancelled: 'Run cancelled.',
  failed: 'Run failed.',
};

const TABS = ['candidates', 'lineage', 'research', 'log'] as const;
type Tab = (typeof TABS)[number];

const score = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '-';

const clamp = (value?: number | null) =>
  Math.min(100, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0));

// Keep short cached runs readable without rounding away their duration.
const elapsed = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export default function RunWorkspace({
  run,
  running,
  onCancel,
}: {
  run: Run;
  running: boolean;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<Tab>('candidates');
  const [selectedRound, setSelectedRound] = useState<string>('latest');
  const [inspecting, setInspecting] = useState<Candidate | null>(null);

  const allCandidates = useMemo(
    () => run.rounds.flatMap((round) => round.candidates),
    [run.rounds]
  );

  const shown = useMemo(() => {
    if (selectedRound === 'final' && run.finalists.length) return run.finalists;
    if (selectedRound === 'latest' || selectedRound === 'final') {
      return run.finalists.length ? run.finalists : (run.rounds.at(-1)?.candidates ?? []);
    }
    return run.rounds.find((r) => String(r.number) === selectedRound)?.candidates ?? [];
  }, [run, selectedRound]);

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
            ['Elapsed', elapsed(run.metrics.elapsedMs)],
          ].map(([label, value]) => (
            <div key={label as string} className="flex flex-col gap-0.5 p-4">
              <dt className="label">{label as string}</dt>
              <dd className="text-2xl tabular-nums text-foreground">{value as string}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="rounded-md border border-border-muted bg-surface-75 px-3 py-2 text-xs text-foreground-lighter">
        {isPercept(run) ? 'Percept overall / 100: four equally weighted Glasser families, normalized against one original creative. Highest neural score wins among reviewed takes. Predicted cortical response, not validated emotion or conversions.' : 'Historical run: these recorded scores use an earlier method, not Percept scoring.'}
        {run.requiresReview && ' No drafts passed review. The retained provisional drafts need review and revision.'}
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

      {tab === 'candidates' && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {run.finalists.length > 0 && (
              <RoundChip active={selectedRound === 'final'} onClick={() => setSelectedRound('final')}>
                {run.requiresReview ? 'Provisional drafts' : 'Finalists'}
              </RoundChip>
            )}
            {run.rounds.map((round) => (
              <RoundChip
                key={round.number}
                active={selectedRound === String(round.number)}
                onClick={() => setSelectedRound(String(round.number))}
              >
                Gen {round.number}
              </RoundChip>
            ))}
          </div>

          {shown.length === 0 ? (
            <Waiting running={running} text="No candidates in this generation yet." />
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {[...shown].sort(compareCandidates).map((candidate, index) => (
                <CreativeCard
                  key={candidate.id}
                  candidate={candidate}
                  rank={index + 1}
                  onClick={() => setInspecting(candidate)}
                />
              ))}
            </div>
          )}

          <FitnessChart run={run} />
        </>
      )}

      {tab === 'lineage' && (
        <div className="flex flex-col gap-5">
          {run.rounds.map((round) => (
            <section key={round.number} className="flex flex-col gap-2">
              <h3 className="label">Generation {round.number}</h3>
              <div className="flex flex-wrap gap-1.5">
                {round.candidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    onClick={() => setInspecting(candidate)}
                    className={cn(
                      'focus-ring rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors',
                      candidate.selected
                        ? 'border-brand-400 bg-brand-200 text-foreground'
                        : 'border-border bg-surface-100 text-foreground-lighter hover:text-foreground'
                    )}
                  >
                    <span className="tabular-nums">{candidate.id}</span>
                    <span className="ml-2 tabular-nums">{score(selectionScore(candidate))}</span>
                    {candidate.parents.length > 0 && (
                      <span className="ml-2 text-foreground-muted">
                        ← {candidate.parents.join(', ')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

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

function RoundChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'focus-ring rounded-md border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-brand-400 bg-brand-200 text-foreground'
          : 'border-border bg-surface-100 text-foreground-lighter hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function Waiting({ running, text }: { running: boolean; text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-5 py-10 text-center text-sm text-foreground-lighter">
      {running ? 'Working…' : text}
    </div>
  );
}

function CreativeCard({
  candidate,
  rank,
  onClick,
}: {
  candidate: Candidate;
  rank: number;
  onClick: () => void;
}) {
  const src = assetLink(candidate.asset?.url);
  return (
    <Panel className="h-full">
      <div className="flex h-full w-full flex-col text-left" data-candidate-id={candidate.id}>
        <div className="relative aspect-square w-full overflow-hidden bg-surface-200">
          {src ? <MediaPreview asset={candidate.asset} title={candidate.headline} className="size-full object-contain" /> : <span className="absolute inset-0 grid place-items-center px-3 text-center text-xs text-foreground-muted">Awaiting media</span>}
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
            {candidate.provisional ? 'PROVISIONAL · NEEDS REVIEW' : candidate.original ? 'ORIGINAL' : rank}
          </span>
        </div>
        <button onClick={onClick} className="focus-ring flex flex-1 flex-col gap-1 p-3 text-left" aria-label={`Inspect ${candidate.headline}`}>
          <p className="line-clamp-2 text-sm text-foreground">{candidate.headline}</p>
          <div className="mt-auto flex w-full items-center justify-between gap-2 pt-1">
            <span className="text-[10px] uppercase tracking-wider text-foreground-muted">{scoreLabel(candidate)}</span>
            <span className="text-sm tabular-nums text-foreground">{score(selectionScore(candidate))}</span>
          </div>
        </button>
      </div>
    </Panel>
  );
}

/** Hand-rolled percentage bars, as in the original: the score domain is a fixed
 *  0-100, so a chart library would add a dependency for two divs. */
function FitnessChart({ run }: { run: Run }) {
  const rounds = run.rounds.filter((round) => Number.isFinite(round.best));
  if (rounds.length < 2) return null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-100 p-5">
      <h3 className="label">{isPercept(run) ? 'Percept score by generation' : 'Historical scores by generation'}</h3>
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
            <span className="text-[10px] text-foreground-lighter">Gen {round.number}</span>
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
