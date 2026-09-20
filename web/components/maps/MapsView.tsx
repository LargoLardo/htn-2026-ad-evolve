'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { assetLink } from '@/lib/api';
import type { Run } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Percept's four families, plus the two synthetic layers this view adds.
 *  auditory_engagement and visual_motion are auditory cortex and the MT+ motion
 *  complex, so on a silent still they sit at parity and read as flat. They are
 *  offered, not defaulted to. */
const IMPACT_METRICS = [
  { key: 'attention_salience', label: 'Attention + salience' },
  { key: 'language_message', label: 'Language / message' },
  { key: 'engagement', label: 'Overall engagement' },
  { key: 'visual_motion', label: 'Visual / motion' },
  { key: 'auditory_engagement', label: 'Auditory' },
] as const;

type Layer = 'attention' | 'impact' | 'gap';

interface MapElement {
  label: string;
  kind: string;
  /** Detection order. This list is sorted by gap, impact.maps is not. */
  order?: number;
  x: number; y: number; w: number; h: number;
  coverage: number;
  attention: number | null;
  impact: number | null;
  gap: number | null;
}

interface MapsArtifact {
  mediaHash: string;
  label?: string;
  elements?: MapElement[];
  attention: { map: number[]; source: string; provenance: string };
  impact: { maps: Record<string, number[]>; calls: number; provenance: string } | null;
  impactError?: string | null;
}

interface MapsJob {
  status: 'idle' | 'running' | 'complete' | 'failed' | 'empty';
  grid?: number;
  targets: { mediaHash: string; label: string; status: string; done: number; total: number; error?: string | null }[];
}

const normalize = (values: number[]) => {
  const min = Math.min(...values), max = Math.max(...values);
  return max - min < 1e-12 ? values.map(() => 0) : values.map(v => (v - min) / (max - min));
};

export default function MapsView({ run }: { run: Run }) {
  const [available, setAvailable] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [data, setData] = useState<MapsArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState<Layer>('gap');
  const [metric, setMetric] = useState<string>('attention_salience');
  const [showLabels, setShowLabels] = useState(true);
  // Hovering a row in the ranked list picks its box out of the overlay. With a
  // dozen boxes on a busy ad the labels necessarily overlap, and the way to
  // read one of them is to ask for one, not to draw fewer.
  const [focused, setFocused] = useState<string | null>(null);
  const [job, setJob] = useState<MapsJob | null>(null);
  const [building, setBuilding] = useState(false);

  /** Every still in the run that could have maps: the uploaded original first,
   *  then finalists, then everything else. Most runs have no uploaded original,
   *  so restricting this to brief.originalAsset would show an empty tab. */
  const mappable = useMemo(() => {
    const seen = new Map<string, { hash: string; url: string; label: string }>();
    const add = (asset: { url?: string; mediaHash?: string; mediaType?: string } | null | undefined, label: string) => {
      if (!asset?.mediaHash || !asset.url || asset.mediaType === 'video') return;
      if (!seen.has(asset.mediaHash)) seen.set(asset.mediaHash, { hash: asset.mediaHash, url: asset.url, label });
    };
    add(run.brief.originalAsset, 'Uploaded original');
    run.finalists.forEach((c, i) => add(c.asset, `Finalist ${i + 1}`));
    run.rounds.forEach(r => r.candidates.forEach(c => add(c.asset, `Gen ${r.number} · ${c.id.slice(-4)}`)));
    return [...seen.values()];
  }, [run]);

  const refreshAvailable = () => {
    fetch('/api/maps')
      .then(r => r.json())
      .then(list => setAvailable(Array.isArray(list) ? list : []))
      .catch(() => setAvailable([]));
  };

  useEffect(() => {
    let live = true;
    fetch('/api/maps')
      .then(r => r.json())
      .then(list => live && setAvailable(Array.isArray(list) ? list : []))
      .catch(() => live && setAvailable([]));
    // A build survives a page reload, so adopt one that is already going
    // rather than offering to start a second.
    fetch(`/api/runs/${run.id}/maps`)
      .then(r => r.json())
      .then(state => { if (live && state?.status === 'running') setJob(state); })
      .catch(() => {});
    return () => { live = false; };
  }, [run.id]);

  // One stream per build. It closes itself when the job finishes, and the
  // artifact list is refetched so the new maps appear without a reload.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const source = new EventSource(`/api/runs/${run.id}/maps/stream`);
    source.onmessage = event => {
      try {
        const next = JSON.parse(event.data) as MapsJob;
        setJob(previous => {
          // A finished target has written its artifact, so the list of
          // available maps is stale from this moment, not from the end of the
          // whole job. Waiting for the job would hide a map that already
          // exists behind the progress bar of the one still building.
          const settled = (state: MapsJob | null) => (state?.targets ?? []).filter(t => t.status !== 'queued' && t.status !== 'running').length;
          if (settled(next) > settled(previous)) refreshAvailable();
          return next;
        });
        if (next.status !== 'running') { source.close(); setBuilding(false); refreshAvailable(); }
      } catch { /* a malformed frame is not worth tearing the stream down */ }
    };
    source.onerror = () => { source.close(); setBuilding(false); };
    return () => source.close();
  }, [job?.status, run.id]);

  const startBuild = async () => {
    setBuilding(true);
    try {
      const response = await fetch(`/api/runs/${run.id}/maps`, { method: 'POST' });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error ?? 'Could not start the map build.');
      setJob(state);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the map build.');
      setBuilding(false);
    }
  };

  const options = useMemo(
    () => (available ? mappable.filter(item => available.includes(item.hash)) : []),
    [available, mappable]
  );

  useEffect(() => { if (!chosen && options.length) setChosen(options[0].hash); }, [chosen, options]);

  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setData(null); setError(null);
    fetch(`/api/maps/${chosen}`)
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Maps unavailable.');
        return body as MapsArtifact;
      })
      .then(body => live && setData(body))
      .catch(caught => live && setError(caught.message));
    return () => { live = false; };
  }, [chosen]);

  const current = options.find(item => item.hash === chosen);
  const src = assetLink(current?.url);

  /**
   * Elements to paint, largest first so a small element drawn inside a big one
   * stays visible. Impact is re-derived for the chosen family, since switching
   * family must not need another GPU pass.
   */
  const painted = useMemo(() => {
    const elements = data?.elements ?? [];
    if (!elements.length) return [];
    const perFamily = data?.impact?.maps?.[metric];
    const impact = perFamily ? normalize(perFamily) : null;
    const attention = normalize(elements.map(element => element.attention ?? 0));
    return elements
      .map((element, index) => {
        // data.elements is sorted by gap, the artifact's maps are in detection
        // order, so the family override has to be looked up by the element's
        // own index rather than its position in this list.
        const own = impact && typeof element.order === 'number' ? impact[element.order] : null;
        const drive = own ?? element.impact ?? 0;
        return { ...element, shown: attention[index] - drive, drive, gaze: attention[index] };
      })
      .sort((a, b) => (b.w * b.h) - (a.w * a.h));
  }, [data, metric]);

  if (available === null) return <Empty>Looking for precomputed maps…</Empty>;
  const progress = job && job.status === 'running' ? <BuildProgress job={job} /> : null;
  // Only take over the whole tab when there is genuinely nothing to show yet.
  if (progress && !options.length) return progress;
  if (!options.length) return (
    <Empty>
      <p>No maps for this run yet.</p>
      <p className="mt-1 text-xs">
        Maps occlude the original and the winner one region at a time and rescore each
        pass, so a build takes a few minutes of GPU.
      </p>
      <button
        onClick={startBuild}
        disabled={building || run.status === 'running'}
        className="focus-ring mt-4 rounded-md border border-brand-400 bg-brand-200 px-3 py-1.5 text-sm text-brand transition-colors disabled:opacity-40"
      >
        {run.status === 'running' ? 'Waiting for the run to finish' : building ? 'Starting…' : 'Build maps for this run'}
      </button>
    </Empty>
  );
  if (error) return <>{progress}<Empty>{error}</Empty></>;
  if (!data) return <>{progress}<Empty>Loading maps…</Empty></>;

  const hasImpact = Boolean(data.impact);
  const elements = data.elements ?? [];

  return (
    <div className="flex flex-col gap-4">
      {progress}
      <div className="flex flex-wrap items-center gap-2">
        {(['attention', 'impact', 'gap'] as Layer[]).map(name => (
          <button
            key={name}
            onClick={() => setLayer(name)}
            disabled={name !== 'attention' && !hasImpact}
            className={cn(
              'focus-ring rounded-md border px-3 py-1.5 text-sm capitalize transition-colors disabled:opacity-40',
              layer === name
                ? 'border-brand-400 bg-brand-200 text-brand'
                : 'border-border bg-surface-100 text-foreground-lighter hover:text-foreground'
            )}
          >
            {name === 'gap' ? 'The gap' : name}
          </button>
        ))}

        {options.length > 1 && (
          <select
            aria-label="Image to map"
            value={chosen ?? ''}
            onChange={event => setChosen(event.target.value)}
            className="rounded-md border border-border-control bg-control px-2 py-1.5 text-xs text-foreground"
          >
            {options.map(item => <option key={item.hash} value={item.hash}>{item.label}</option>)}
          </select>
        )}

        {elements.length > 0 && (
          <button
            onClick={() => setShowLabels(value => !value)}
            className={cn(
              'focus-ring rounded-md border px-3 py-1.5 text-sm transition-colors',
              showLabels
                ? 'border-brand-400 bg-brand-200 text-brand'
                : 'border-border bg-surface-100 text-foreground-lighter hover:text-foreground'
            )}
          >
            Labels
          </button>
        )}

        {layer !== 'attention' && hasImpact && (
          <select
            aria-label="Impact metric"
            value={metric}
            onChange={event => setMetric(event.target.value)}
            className="ml-auto rounded-md border border-border-control bg-control px-2 py-1.5 text-xs text-foreground"
          >
            {IMPACT_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="relative overflow-hidden rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {src && <img src={src} alt="Ad being mapped" className="block w-full" />}

          {/* Attention is a continuous 1024px density, painted from the heatmap
              PNG. Impact and the gap are one measurement per element, so they
              paint the elements themselves. Anywhere no element was detected
              stays unpainted, which is honest: nothing was measured there. A
              grid used to imply the whole ad had been measured. */}
          {layer === 'attention' ? (
            <AttentionHeatmap src={`/api/maps/${chosen}/attention.png`} />
          ) : (
            <div className="pointer-events-none absolute inset-0">
              {painted.map((element, index) => (
                <div
                  key={index}
                  className="absolute"
                  style={{
                    left: `${element.x * 100}%`, top: `${element.y * 100}%`,
                    width: `${element.w * 100}%`, height: `${element.h * 100}%`,
                    background: layer === 'gap' ? gapShade(element.shown) : driveShade(element.drive),
                  }}
                />
              ))}
            </div>
          )}

          {showLabels && elements.map((element, index) => {
            const dim = focused !== null && focused !== element.label;
            return (
              <div
                key={index}
                className={cn(
                  'pointer-events-none absolute transition-opacity duration-150',
                  focused === element.label
                    ? 'border-2 border-white shadow-[0_0_0_2px_rgba(0,0,0,0.7)]'
                    : 'border border-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.55)]'
                )}
                style={{
                  left: `${element.x * 100}%`, top: `${element.y * 100}%`,
                  width: `${element.w * 100}%`, height: `${element.h * 100}%`,
                  opacity: dim ? 0.15 : 1,
                  zIndex: focused === element.label ? 2 : 1,
                }}
              >
                <span className="absolute left-0 top-0 max-w-full truncate bg-black/80 px-1 text-[10px] text-white">
                  {element.label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 text-sm">
          <Legend layer={layer} />
          {!hasImpact && (
            <p className="rounded-md border border-border-muted bg-surface-75 px-3 py-2 text-xs text-foreground-lighter">
              Only the attention map is available. {data.impactError ?? 'The impact map needs the Percept worker.'}
            </p>
          )}
          {elements.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="label">What each part is doing</p>
              <ul className="flex flex-col gap-2.5">
                {painted
                  .slice()
                  .sort((a, b) => b.shown - a.shown)
                  .map((element, index) => (
                    <li
                      key={index}
                      onMouseEnter={() => setFocused(element.label)}
                      onMouseLeave={() => setFocused(current => (current === element.label ? null : current))}
                      className={cn(
                        'flex cursor-default flex-col gap-1 rounded-md px-2 py-1.5 transition-colors',
                        focused === element.label ? 'bg-surface-200' : 'bg-transparent'
                      )}
                    >
                      <span className="truncate text-xs text-foreground" title={element.label}>{element.label}</span>
                      <Bar label="looked at" value={element.gaze} tint="rgb(148,163,184)" />
                      <Bar label="does" value={element.drive} tint="rgb(148,163,184)" />
                      <span className="text-[11px]" style={{ color: verdictColour(element.shown) }}>
                        {verdict(element.shown)}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {/* One line, with the methodology behind a hover. Two paragraphs of
              provenance under every map is read once and then never again,
              which is the opposite of what a caveat is for. */}
          <p className="text-xs text-foreground-lighter">
            <span title={data.attention.provenance} className="cursor-help underline decoration-dotted underline-offset-2">
              Predicted gaze
            </span>
            {data.impact ? (
              <>
                {' and '}
                <span title={data.impact.provenance} className="cursor-help underline decoration-dotted underline-offset-2">
                  measured response
                </span>
                . Predicted, not observed.
              </>
            ) : '. The impact map needs the Percept worker.'}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Magma, the standard perceptually uniform heat ramp.
 *
 * A single hue at varying alpha, which this used to be, is unreadable over a
 * photograph: the ad's own colours show through and a bright ad region reads
 * hotter than a dim one regardless of its value. A ramp that moves through
 * hue AND lightness together stays legible on any background, and the order
 * dark to bright survives greyscale printing and colour blindness.
 */
const MAGMA: [number, number, number][] = [
  [12, 8, 38], [87, 16, 110], [187, 55, 84], [249, 142, 9], [252, 255, 164],
];

function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (MAGMA.length - 1);
  const i = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - i;
  const a = MAGMA[i], b = MAGMA[i + 1];
  return [0, 1, 2].map(c => Math.round(a[c] + (b[c] - a[c]) * f)) as [number, number, number];
}

/** The gap is signed, so it needs a diverging ramp with a neutral middle or
 *  "the two maps agree" would read as an extreme. Orange against cyan is the
 *  highest-contrast opposed pair that survives both colour blindness and a
 *  photographic background. */
function gapShade(value: number) {
  const weight = 0.22 + Math.min(0.6, Math.abs(value) * 0.6);
  return value >= 0 ? `rgba(255, 130, 40, ${weight})` : `rgba(34, 205, 225, ${weight})`;
}

function driveShade(value: number) {
  const [r, g, b] = ramp(value);
  // Floor the alpha so a cold element still reads as measured rather than
  // absent. Absent means no element was detected there at all.
  return `rgba(${r}, ${g}, ${b}, ${0.25 + Math.min(0.62, value * 0.62)})`;
}

/**
 * Paint the full-resolution attention density through the ramp.
 *
 * The artifact PNG carries density in its alpha channel, so it was previously
 * drawn as a CSS mask over one flat colour. That threw away every value
 * between "nothing" and "peak". Reading the pixels back and mapping each one
 * through the ramp keeps the resolution we already paid for.
 */
function AttentionHeatmap({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const data = pixels.data;
      for (let i = 0; i < data.length; i += 4) {
        const density = data[i + 3] / 255;
        const [r, g, b] = ramp(density);
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
        // Keep the faint end translucent so the ad stays visible underneath.
        data[i + 3] = Math.round(Math.min(1, density * 1.15) * 235);
      }
      context.putImageData(pixels, 0, 0);
    };
    image.src = src;
    return () => { cancelled = true; };
  }, [src]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 size-full" />;
}

function Legend({ layer }: { layer: Layer }) {
  if (layer === 'attention') return <Note title="Where eyes go">DeepGaze IIE predicted fixation density. Brighter means more predicted gaze.</Note>;
  if (layer === 'impact') return <Note title="What moves the response">Each element is hidden and the ad rescored. Brighter means hiding it changed the predicted response more.</Note>;
  return (
    <Note title="Looked at, versus what moves the response">
      <span className="text-[#ff8228]">Orange</span> is dead weight.{' '}
      <span className="text-[#22cde1]">Cyan</span> is carrying the ad. Unpainted means no element was detected there,
      so nothing was measured.
    </Note>
  );
}

const Note = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-100 p-3">
    <span className="label">{title}</span>
    <p className="text-xs text-foreground-light">{children}</p>
  </div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border border-dashed border-border px-5 py-10 text-center text-sm text-foreground-lighter">
    {children}
  </div>
);


/** The build, pass by pass.
 *
 * A percentage would be a worse thing to watch than the count of regions
 * already rescored, because the count says what the machine is actually doing
 * and a percentage only says how long is left.
 */
function BuildProgress({ job }: { job: MapsJob }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-75 p-5">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-foreground">Building maps</p>
        <p className="text-xs text-foreground-lighter">
          Each pass hides one region of the ad and rescores it with Percept. Nothing is lost
          if you leave this tab.
        </p>
      </div>
      {job.targets.map(target => {
        const fraction = target.total ? target.done / target.total : 0;
        return (
          <div key={target.mediaHash} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-foreground">{target.label}</span>
              <span className="tabular-nums text-foreground-lighter">
                {target.status === 'queued' && 'queued'}
                {target.status === 'running' && (target.total ? `${target.done}/${target.total} regions` : 'predicting gaze…')}
                {target.status === 'done' && 'done'}
                {target.status === 'attention-only' && 'attention only'}
                {target.status === 'failed' && 'failed'}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-300">
              <div
                className={cn('h-full rounded-full transition-[width] duration-500',
                  target.status === 'failed' ? 'bg-destructive' : 'bg-brand')}
                style={{ width: `${target.status === 'done' ? 100 : Math.round(fraction * 100)}%` }}
              />
            </div>
            {target.error && <p className="text-xs text-foreground-lighter">{target.error}</p>}
          </div>
        );
      })}
    </div>
  );
}


/**
 * The verdict, in words.
 *
 * This used to be a signed number, which collided with the score on the node
 * cards where a minus sign means worse. Here a minus sign meant the element
 * was carrying the ad, so the same symbol meant opposite things on one screen.
 * Words cannot collide.
 */
const DEAD = 0.15;

function verdict(value: number) {
  if (value > DEAD) return 'dead weight';
  if (value < -DEAD) return 'carrying the ad';
  return 'neutral';
}

function verdictColour(value: number) {
  if (value > DEAD) return '#ff8228';
  if (value < -DEAD) return '#22cde1';
  return 'var(--color-foreground-lighter, #8b8b8b)';
}

/** Two bars beat one subtraction: you compare lengths instead of reading a
 *  difference someone else already computed for you. */
function Bar({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] text-foreground-lighter">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-300">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, background: tint }}
        />
      </span>
    </span>
  );
}
