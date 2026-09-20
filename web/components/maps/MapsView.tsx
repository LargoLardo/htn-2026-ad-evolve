'use client';

import { useEffect, useMemo, useState } from 'react';
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

interface MapsArtifact {
  mediaHash: string;
  grid: number;
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
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundColor: 'rgb(199, 240, 120)',
                WebkitMaskImage: `url(/api/maps/${chosen}/attention.png)`,
                maskImage: `url(/api/maps/${chosen}/attention.png)`,
                WebkitMaskSize: '100% 100%',
                maskSize: '100% 100%',
                opacity: 0.78,
              }}
            />
          ) : (
            <div
              className="absolute inset-0 grid"
              style={{ gridTemplateColumns: `repeat(${grid}, 1fr)`, gridTemplateRows: `repeat(${grid}, 1fr)` }}
            >
              {values.map((value, index) => (
                <div key={index} className="relative border border-white/10" style={{ background: shade(value, layer) }}>
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white">
                    {layer === 'gap' ? (value >= 0 ? '+' : '') : ''}{value.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 text-sm">
          <Legend layer={layer} />
          {!hasImpact && (
            <p className="rounded-md border border-border-muted bg-surface-75 px-3 py-2 text-xs text-foreground-lighter">
              Only the attention map is available. {data.impactError ?? 'The impact map needs the Percept worker.'}
            </p>
          )}
          <p className="text-xs text-foreground-lighter">{data.attention.provenance}</p>
          {data.impact && <p className="text-xs text-foreground-lighter">{data.impact.provenance}</p>}
        </div>
      </div>
    </div>
  );
}

/** Attention and impact are one-sided, so they ramp in a single hue. The gap is
 *  signed and needs a diverging ramp with a neutral middle, or "no disagreement"
 *  would look like an extreme. */
function shade(value: number, layer: Layer) {
  if (layer === 'gap') {
    return value >= 0
      ? `rgba(255, 138, 76, ${Math.min(0.72, Math.abs(value) * 0.72)})`
      : `rgba(120, 160, 255, ${Math.min(0.72, Math.abs(value) * 0.72)})`;
  }
  return `rgba(199, 240, 120, ${Math.min(0.72, value * 0.72)})`;
}

function Legend({ layer }: { layer: Layer }) {
  if (layer === 'attention') return <Note title="Where eyes go">DeepGaze IIE predicted fixation density. Brighter means more predicted gaze.</Note>;
  if (layer === 'impact') return <Note title="What moves the response">Occlude a cell, rescore with Percept, measure the drop. Brighter means occluding it changed the predicted response more.</Note>;
  return (
    <Note title="Attention minus impact">
      <span className="text-[#ff8a4c]">Orange</span> is looked at but does nothing.{' '}
      <span className="text-[#78a0ff]">Blue</span> drives the response without drawing the eye. Faint means the two agree.
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
