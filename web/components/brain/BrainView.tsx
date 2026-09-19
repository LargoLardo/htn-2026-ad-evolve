'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { assetLink } from '@/lib/api';
import type { Candidate, NeuralScore, Run } from '@/lib/types';
import { cn } from '@/lib/utils';
import BrainCanvas from './BrainCanvas';

/** Family order and colours come from worker/percept_score.py, so the surface, the
 *  legend and the traces all name the same four families. */
const FAMILIES = [
  { key: 'auditory_engagement', color: '#ffb13b' },
  { key: 'language_message', color: '#ff5a7a' },
  { key: 'attention_salience', color: '#9b8cff' },
  { key: 'visual_motion', color: '#3fd6c0' },
] as const;

const CHART = { width: 960, height: 200, left: 44, right: 56, top: 18, bottom: 28 };

/** 50 is parity with the original creative, so only the distance above it glows. */
const PARITY = 50;
const FULL = 75;
const intensity = (value: number) => Math.max(0, Math.min(1, (value - PARITY) / (FULL - PARITY)));

const familyColor = (key: string, fallback?: string) =>
  fallback ?? FAMILIES.find((family) => family.key === key)?.color ?? '#9b8cff';

/** Written by experimental/export_brain_mesh.py from the worker's own family patterns. */
interface MeshManifest {
  families: {
    index: number;
    key: string;
    name: string;
    short: string;
    reliability: string;
    vertexCount: number;
    parcels: string[];
  }[];
}

const trace = (neural: NeuralScore, key: string) =>
  neural.regions?.find((region) => region.key === key)?.values ?? [];

export default function BrainView({ run }: { run: Run }) {
  const scored = useMemo(() => {
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const round of run.rounds) {
      for (const candidate of round.candidates) {
        if (candidate.scores?.neural?.regions?.length && !seen.has(candidate.id)) {
          seen.add(candidate.id);
          candidates.push(candidate);
        }
      }
    }
    return candidates;
  }, [run.rounds]);

  const fallback = run.finalists.length ? run.finalists : (run.rounds.at(-1)?.candidates ?? []);
  const shown = scored.length ? scored : fallback;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shown.find((candidate) => candidate.id === selectedId) ?? shown[0] ?? null;
  const neural = selected?.scores?.neural ?? null;

  const regions = useMemo(() => {
    if (!neural?.regions?.length) return [];
    return FAMILIES.map((family) => {
      const region = neural.regions?.find((item) => item.key === family.key);
      return {
        key: family.key,
        name: region?.name ?? family.key.replace(/_/g, ' '),
        score: region?.score ?? PARITY,
        color: familyColor(family.key, region?.color),
        values: region?.values ?? [],
      };
    });
  }, [neural]);

  const frames = regions[0]?.values.length ?? 0;
  const duration = neural?.duration ?? frames;
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const started = useRef<number>(0);

  // One frame per second of stimulus, looping, so the cortex replays the ad's own
  // trace rather than a decorative animation.
  useEffect(() => {
    setFrame(0);
    if (!playing || frames < 2) return;
    started.current = performance.now();
    let request = 0;
    const seconds = duration > 0 ? duration : frames;
    const tick = (now: number) => {
      const elapsed = ((now - started.current) / 1000) % seconds;
      setFrame(Math.min(frames - 1, Math.floor((elapsed / seconds) * frames)));
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [duration, frames, playing, selected?.id]);

  // Without Percept data there is nothing to replay, so the families breathe gently
  // and the panel says so.
  const [idlePhase, setIdlePhase] = useState(0);
  useEffect(() => {
    if (regions.length) return;
    let request = 0;
    const tick = (now: number) => {
      setIdlePhase(now / 1000);
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [regions.length]);

  const levels = useMemo(() => {
    if (!regions.length) {
      return FAMILIES.map((_family, index) => 0.25 + 0.25 * Math.sin(idlePhase * 0.8 + index * 1.4));
    }
    return regions.map((region) => intensity(region.values[frame] ?? region.score));
  }, [frame, idlePhase, regions]);

  const colors = useMemo(
    () => (regions.length ? regions.map((region) => region.color) : FAMILIES.map((family) => family.color)),
    [regions]
  );

  const select = useCallback((id: string) => setSelectedId(id), []);
  const illustrative = regions.length === 0;

  // 0 means nothing is picked; 1-4 index the families in FAMILIES order.
  const [family, setFamily] = useState(0);
  const [manifest, setManifest] = useState<MeshManifest | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/brain/manifest.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: MeshManifest | null) => {
        if (!cancelled) setManifest(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const detail = family > 0 ? manifest?.families.find((item) => item.index === family) : undefined;
  const detailRegion = family > 0 ? regions[family - 1] : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
        <div className="relative h-[520px] overflow-hidden rounded-lg border border-border bg-black">
          <BrainCanvas
            levels={levels}
            colors={colors}
            activityLevel={1}
            selected={family}
            onSelect={setFamily}
          />

          <div className="pointer-events-none absolute left-5 top-5 flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.16em] text-white/40">
              fsaverage5 pial · glasser families · webgl
            </span>
            {neural ? (
              <>
                <span className="text-5xl font-light tabular-nums text-white">
                  {(neural.engagementScore ?? PARITY).toFixed(1)}
                  <span className="text-xl text-white/50">/100</span>
                </span>
                <span className="max-w-[30ch] text-xs text-white/60">
                  Percept overall · 50 matches the original creative
                </span>
              </>
            ) : (
              <span className="max-w-[28ch] text-xs text-white/60">
                No Percept score for this run.
              </span>
            )}
          </div>

          {illustrative && (
            <div className="pointer-events-none absolute right-5 top-5 max-w-[26ch] rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-right">
              <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-amber-200">
                Illustrative — not model output
              </p>
              <p className="mt-1 text-[11px] text-white/50">
                The four Percept families are shown breathing. Nothing here was predicted from an ad.
              </p>
            </div>
          )}

          {frames > 1 && (
            <div className="absolute bottom-5 left-5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setPlaying((current) => !current)}
                className="focus-ring grid size-8 place-items-center rounded-full border border-white/20 bg-black/60 text-white/80 backdrop-blur transition-colors hover:text-white"
                aria-label={playing ? 'Pause playback' : 'Play the response over time'}
              >
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <span className="text-[11px] tabular-nums text-white/50">
                {frame + 1}s / {Math.round(duration)}s
              </span>
            </div>
          )}
        </div>

        <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-100 p-5">
          <h3 className="label">Response systems</h3>
          {regions.length ? (
            <ul className="flex flex-col gap-1">
              {regions.map((region, index) => (
                <li key={region.key}>
                  <button
                    type="button"
                    onClick={() => setFamily(family === index + 1 ? 0 : index + 1)}
                    aria-pressed={family === index + 1}
                    className={cn(
                      'focus-ring flex w-full flex-col gap-1.5 rounded-md px-2 py-2 text-left transition-colors',
                      family === index + 1 ? 'bg-surface-200' : 'hover:bg-surface-200/60',
                      family !== 0 && family !== index + 1 && 'opacity-45'
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex items-center gap-2 text-xs text-foreground-light">
                        <i
                          aria-hidden
                          className="size-2 shrink-0 rounded-full"
                          style={{ background: region.color }}
                        />
                        {region.name}
                      </span>
                      <span className="text-xs tabular-nums text-foreground">
                        {(region.values[frame] ?? region.score).toFixed(1)}
                      </span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-border-muted">
                      <i
                        className="block h-full rounded-full"
                        style={{
                          width: `${Math.max(2, levels[index] * 100)}%`,
                          background: region.color,
                        }}
                      />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-foreground-lighter">
              Family traces appear once a run is scored with the Percept worker.
            </p>
          )}
          {detail ? (
            <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-surface-200 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-sm text-foreground">{detail.name}</h4>
                <button
                  type="button"
                  onClick={() => setFamily(0)}
                  className="focus-ring text-[11px] text-foreground-lighter hover:text-foreground"
                >
                  Clear
                </button>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <dt className="text-foreground-muted">Reliability</dt>
                <dd className="text-foreground-light">{detail.reliability}</dd>
                <dt className="text-foreground-muted">Glasser parcels</dt>
                <dd className="text-foreground-light">{detail.parcels.length}</dd>
                <dt className="text-foreground-muted">Vertices</dt>
                <dd className="text-foreground-light">{detail.vertexCount.toLocaleString()}</dd>
                {detailRegion && (
                  <>
                    <dt className="text-foreground-muted">Mean</dt>
                    <dd className="text-foreground-light tabular-nums">{detailRegion.score.toFixed(1)}</dd>
                    <dt className="text-foreground-muted">Peak</dt>
                    <dd className="text-foreground-light tabular-nums">
                      {Math.max(...detailRegion.values).toFixed(1)} at{' '}
                      {detailRegion.values.indexOf(Math.max(...detailRegion.values)) + 1}s
                    </dd>
                  </>
                )}
              </dl>
              <p className="text-[11px] leading-relaxed text-foreground-lighter">
                {detail.parcels.join(', ')}
              </p>
            </div>
          ) : (
            <p className="mt-2 rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-foreground-lighter">
              Click a lit region on the cortex, or a row above, to inspect its parcels.
            </p>
          )}

          <p className="mt-auto border-t border-border pt-3 text-[11px] text-foreground-lighter">
            {neural?.provenance ??
              'Predicted cortical response over Glasser parcels, not validated emotion or conversions.'}
          </p>
        </section>
      </div>

      {shown.length > 0 && (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-100 p-5">
          <h3 className="label">{scored.length ? 'Scored takes' : 'Rendered takes'}</h3>
          <div className="flex flex-wrap gap-2">
            {shown.map((candidate) => {
              const source = assetLink(candidate.asset?.url);
              const isVideo = candidate.asset?.mediaType === 'video';
              return (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => select(candidate.id)}
                  aria-pressed={candidate.id === selected?.id}
                  title={candidate.headline}
                  className={cn(
                    'focus-ring size-16 overflow-hidden rounded-md border transition-colors',
                    candidate.id === selected?.id
                      ? 'border-brand-400'
                      : 'border-border hover:border-border-stronger'
                  )}
                >
                  {source && !isVideo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={source} alt={candidate.headline} className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center px-1 text-center text-[9px] uppercase text-foreground-muted">
                      {isVideo ? 'Video' : 'No media'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {regions.length > 0 && frames > 1 && (
        <FamilyTraces regions={regions} frame={frame} duration={duration} selected={family} />
      )}
    </div>
  );
}

/** Four series on one fixed 0-100 axis. The dashed line is parity with the original
 *  creative, and the playhead is the frame the cortex is showing. */
function FamilyTraces({
  regions,
  frame,
  duration,
  selected,
}: {
  regions: { key: string; name: string; color: string; values: number[] }[];
  frame: number;
  duration: number;
  selected: number;
}) {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const frames = regions[0]?.values.length ?? 0;
  const xFor = (index: number) => CHART.left + (frames > 1 ? (index / (frames - 1)) * plotWidth : 0);
  const yFor = (value: number) =>
    CHART.top + plotHeight * (1 - Math.max(0, Math.min(100, value)) / 100);
  const parity = yFor(PARITY);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-100 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="label">Response over the {Math.round(duration)}s stimulus</h3>
        <span className="text-[11px] text-foreground-lighter">
          50 matches the original creative
        </span>
      </div>

      <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} className="h-48 w-full" role="img">
        <line
          x1={CHART.left}
          x2={CHART.width - CHART.right}
          y1={parity}
          y2={parity}
          stroke="currentColor"
          strokeDasharray="6 6"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          className="text-border-stronger"
        />
        <text x={8} y={parity + 4} className="fill-foreground-muted text-[11px]">
          50
        </text>
        <line
          x1={xFor(frame)}
          x2={xFor(frame)}
          y1={CHART.top}
          y2={CHART.height - CHART.bottom}
          stroke="currentColor"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          className="text-foreground-muted"
        />
        {regions.map((region, index) => {
          const path = region.values
            .map((value, point) => `${point === 0 ? 'M' : 'L'}${xFor(point).toFixed(1)} ${yFor(value).toFixed(1)}`)
            .join(' ');
          const last = region.values.at(-1) ?? PARITY;
          const faded = selected !== 0 && selected !== index + 1;
          return (
            <g key={region.key} opacity={faded ? 0.25 : 1}>
              <path
                d={path}
                fill="none"
                stroke={region.color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={xFor(frame)} cy={yFor(region.values[frame] ?? last)} r={4} fill={region.color} />
              <text
                x={CHART.width - CHART.right + 6}
                y={yFor(last) + 4}
                fill={region.color}
                className="text-[11px] tabular-nums"
              >
                {last.toFixed(0)}
              </text>
            </g>
          );
        })}
      </svg>

      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {regions.map((region, index) => (
          <li
            key={region.key}
            className={cn(
              'flex items-center gap-1.5 text-[11px] text-foreground-lighter',
              selected !== 0 && selected !== index + 1 && 'opacity-45'
            )}
          >
            <i aria-hidden className="size-2 rounded-full" style={{ background: region.color }} />
            {region.name}
          </li>
        ))}
      </ul>
    </section>
  );
}
