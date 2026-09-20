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
  x: number; y: number; w: number; h: number;
  coverage: number;
  attention: number | null;
  impact: number | null;
  gap: number | null;
}

interface MapsArtifact {
  mediaHash: string;
  grid: number;
  elements?: MapElement[];
  attention: { map: number[]; source: string; provenance: string };
  impact: { maps: Record<string, number[]>; calls: number; provenance: string } | null;
  impactError?: string | null;
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

  useEffect(() => {
    let live = true;
    fetch('/api/maps')
      .then(r => r.json())
      .then(list => live && setAvailable(Array.isArray(list) ? list : []))
      .catch(() => live && setAvailable([]));
    return () => { live = false; };
  }, []);

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

  const values = useMemo(() => {
    if (!data) return null;
    const attention = normalize(data.attention.map);
    const impactRaw = data.impact?.maps[metric] ?? data.impact?.maps.engagement;
    const impact = impactRaw ? normalize(impactRaw) : null;
    if (layer === 'attention') return attention;
    if (layer === 'impact') return impact;
    // Gap is signed, so it is scaled by its own largest magnitude rather than
    // min-max normalised; zero has to stay in the middle or the colours lie.
    if (!impact) return null;
    const diff = attention.map((v, i) => v - impact[i]);
    const scale = Math.max(...diff.map(Math.abs)) || 1;
    return diff.map(v => v / scale);
  }, [data, layer, metric]);

  if (available === null) return <Empty>Looking for precomputed maps…</Empty>;
  if (!options.length) return (
    <Empty>
      No precomputed maps for any image in this run. Build one with{' '}
      <code>node scripts/build-demo-maps.mjs --image data/assets/&lt;hash&gt;.png</code>
    </Empty>
  );
  if (error) return <Empty>{error}</Empty>;
  if (!data || !values) return <Empty>Loading maps…</Empty>;

  const grid = data.grid;
  const hasImpact = Boolean(data.impact);
  const elements = data.elements ?? [];

  return (
    <div className="flex flex-col gap-4">
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

          {/* Attention is a continuous 1024px density, so it is painted from the
              heatmap PNG rather than reduced to cells. The PNG is greyscale and
              is used as a mask over a flat colour, which keeps the artifact
              generic and lets the theme pick the hue. Impact and the gap stay
              cellular because each cell is one GPU call and there is no finer
              signal to show. */}
          {layer === 'attention' ? (
            <AttentionHeatmap src={`/api/maps/${chosen}/attention.png`} />
          ) : (
            <div
              className="absolute inset-0 grid"
              style={{ gridTemplateColumns: `repeat(${grid}, 1fr)`, gridTemplateRows: `repeat(${grid}, 1fr)` }}
            >
              {values.map((value, index) => (
                <div key={index} className="relative border border-white/10" style={{ background: shade(value, layer) }}>
                  {/* Per-cell numbers stop being readable once cells are small,
                      and at that point the element labels carry the meaning. */}
                  {grid <= 4 && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white">
                      {layer === 'gap' ? (value >= 0 ? '+' : '') : ''}{value.toFixed(2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {showLabels && elements.map((element, index) => (
            <div
              key={index}
              className="pointer-events-none absolute border border-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
              style={{
                left: `${element.x * 100}%`, top: `${element.y * 100}%`,
                width: `${element.w * 100}%`, height: `${element.h * 100}%`,
              }}
            >
              <span className="absolute left-0 top-0 max-w-full truncate bg-black/80 px-1 text-[10px] text-white">
                {element.label}
              </span>
            </div>
          ))}
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
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                {elements.map((element, index) => (
                  <li key={index} className="flex items-baseline justify-between gap-2 bg-surface-100 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={element.label}>{element.label}</span>
                    <span
                      className="shrink-0 text-[11px] tabular-nums"
                      style={{ color: (element.gap ?? 0) >= 0 ? '#ff8228' : '#22cde1' }}
                      title={(element.gap ?? 0) >= 0 ? 'Looked at more than it moves the response' : 'Moves the response more than it is looked at'}
                    >
                      {(element.gap ?? 0) >= 0 ? '+' : ''}{(element.gap ?? 0).toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-foreground-lighter">
                Sorted worst first. Positive is dead weight: looked at, does not move the response.
              </p>
            </div>
          )}
          <p className="text-xs text-foreground-lighter">{data.attention.provenance}</p>
          {data.impact && <p className="text-xs text-foreground-lighter">{data.impact.provenance}</p>}
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
function shade(value: number, layer: Layer) {
  if (layer === 'gap') {
    const weight = Math.min(0.85, Math.abs(value) * 0.85);
    return value >= 0 ? `rgba(255, 130, 40, ${weight})` : `rgba(34, 205, 225, ${weight})`;
  }
  const [r, g, b] = ramp(value);
  // Floor the alpha so a cold cell still reads as measured rather than absent.
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
  if (layer === 'impact') return <Note title="What moves the response">Occlude a cell, rescore with Percept, measure the drop. Brighter means occluding it changed the predicted response more.</Note>;
  return (
    <Note title="Attention minus impact">
      <span className="text-[#ff8228]">Orange</span> is looked at but does nothing.{' '}
      <span className="text-[#22cde1]">Cyan</span> drives the response without drawing the eye. Faint means the two agree.
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
