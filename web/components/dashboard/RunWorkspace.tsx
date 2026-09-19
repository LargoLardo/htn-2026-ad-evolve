'use client';

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import CreativeInspector from './CreativeInspector';
import { assetLink, exportHref, safeLink } from '@/lib/api';
import { EMOTIONS, type Candidate, type Run, type RunStage } from '@/lib/types';
import { cn } from '@/lib/utils';

const STAGE_TEXT: Record<RunStage, string> = {
  queued: 'Queued.',
  research: 'Researching the brief…',
  generating: 'Generating creative genomes…',
  screening: 'Screening concepts against the heuristic…',
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
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : '—';

const clamp = (value?: number | null) =>
  Math.min(100, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0));

// A demo run finishes in tens of milliseconds, where seconds-to-one-decimal just
// reads "0.0s". Switch units rather than lose the number.
const elapsed = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export default function RunWorkspace({
  run,
  running,
  onCancel,
  onNew,
}: {
  run: Run;
  running: boolean;
  onCancel: () => void;
  onNew: () => void;
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
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="flex flex-col gap-1">
            <span className="label">Experiment</span>
            <h2 className="text-xl text-foreground">{run.brief.product}</h2>
            <p role="status" aria-live="polite" className="text-sm text-foreground-lighter">
              {run.error ?? STAGE_TEXT[run.stage] ?? run.stage}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <Button type="button" size="small" onClick={onCancel}>
                Stop run
              </Button>
            ) : (
              <Button type="button" size="small" onClick={onNew}>
                New experiment
              </Button>
            )}
            {!running && (
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
            ['Cache hits', run.metrics.cacheHits],
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
        {run.brief.scorer === 'tribe'
          ? 'TRIBE plus an experimental fitted decoder. Scores estimate ratings; predictive validity must be established separately.'
          : 'Design heuristic out of 100. These are illustrative design priors, not measured emotions or predicted conversions.'}
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
          {run.status}
        </span>
      </div>

      {tab === 'candidates' && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {run.finalists.length > 0 && (
              <RoundChip active={selectedRound === 'final'} onClick={() => setSelectedRound('final')}>
                Finalists
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
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
              {shown.map((candidate, index) => (
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
                    <span className="font-mono">{candidate.id}</span>
                    <span className="ml-2 tabular-nums">{score(candidate.scores?.fitness)}</span>
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
                  <span className="font-mono text-xs text-foreground-muted">
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
              <time className="shrink-0 font-mono text-foreground-muted">
                {new Date(event.time).toLocaleTimeString()}
              </time>
              <span className="text-foreground-light">{event.message}</span>
            </li>
          ))}
        </ul>
      )}

      <CreativeInspector
        candidate={inspecting}
        product={run.brief.product}
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
      <button onClick={onClick} className="focus-ring flex h-full w-full flex-col text-left">
        <div className="relative aspect-square w-full overflow-hidden bg-surface-200">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={candidate.headline} className="size-full object-cover" />
          ) : (
            <span className="absolute inset-0 grid place-items-center px-3 text-center text-[10px] uppercase tracking-wider text-foreground-muted">
              Concept · not rendered
            </span>
          )}
          <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
            {rank}
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1 p-3">
          <p className="line-clamp-2 text-sm text-foreground">{candidate.headline}</p>
          <div className="mt-auto flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] uppercase tracking-wider text-foreground-muted">
              {candidate.scores?.source === 'tribe-calibrated' ? 'TRIBE' : 'Heuristic'}
            </span>
            <span className="text-sm tabular-nums text-foreground">
              {score(candidate.scores?.fitness)}
            </span>
          </div>
        </div>
      </button>
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
      <h3 className="label">Fitness by generation</h3>
      <div className="flex items-end gap-4">
        {rounds.map((round) => (
          <div key={round.number} className="flex flex-1 flex-col items-center gap-2">
            <div className="flex h-32 w-full items-end justify-center gap-1">
              <div
                className="w-1/3 rounded-t bg-brand transition-[height] duration-500"
                style={{ height: `${clamp(round.best)}%` }}
                title={`Best ${score(round.best)}`}
              />
              <div
                className="w-1/3 rounded-t bg-border-stronger transition-[height] duration-500"
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

export { EMOTIONS };
