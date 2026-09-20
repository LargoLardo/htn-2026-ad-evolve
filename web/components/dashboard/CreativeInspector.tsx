'use client';

import { Download } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { assetLink } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Candidate } from '@/lib/types';
import { scoreDisplay, scoreLabel } from '@/lib/scores';
import MediaPreview from './MediaPreview';

const score = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—';
const clamp = (value: number) => Math.min(100, Math.max(0, value));

function ScoreRow({ label, value }: { label: string; value: number }) {
  return <div className="grid grid-cols-[minmax(100px,1fr)_1fr_36px] items-center gap-2">
    <span className="text-xs text-foreground-light">{label}</span>
    <div className="h-1.5 overflow-hidden rounded-full bg-border-muted"><i className="block h-full rounded-full bg-brand" style={{ width: `${clamp(value)}%` }} /></div>
    <span className="text-right text-xs tabular-nums text-foreground-lighter">{score(value)}</span>
  </div>;
}

export default function CreativeInspector({ candidate, product, originalLabel, onClose }: {
  candidate: Candidate | null; product: string; originalLabel?: string; onClose: () => void;
}) {
  const src = assetLink(candidate?.asset?.url);
  const slug = product.replace(/[^a-z0-9]/gi, '-');
  const review = candidate?.scores?.review;
  const neural = candidate?.scores?.neural;
  return <Dialog open={!!candidate} onClose={onClose} label="Creative inspector">
    {candidate && <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_1.2fr]">
      <div className="flex flex-col gap-3">
        {src ? <>
          <MediaPreview asset={candidate.asset} title={candidate.headline} className="w-full rounded-lg border border-border" />
          <a href={src} download={`${slug}-${candidate.id}.${src.split('.').at(-1)}`} className="focus-ring inline-flex items-center justify-center gap-2 rounded-md border border-border-button bg-surface-100 px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-200"><Download size={14} /> Download draft</a>
        </> : <p className="text-sm text-foreground-lighter">No media is available yet.</p>}
        <p className="text-xs text-foreground-lighter">{neural?.source === ‘tribe-neural’ ? ‘TRIBE evaluated this media using neural scoring.’ : review ? ‘Automated media review is available below.’ : ‘No neural evaluation has been recorded.’}</p>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl text-foreground">{candidate.headline}</h2>
          <p className="text-sm text-foreground-light">{candidate.body}</p>
          <span className="text-xs text-foreground-lighter">CTA · {candidate.cta}</span>
          {candidate.provisional && <p role="status" className="text-sm text-destructive">Provisional draft — failed review checks remain unresolved.</p>}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="label">Traits</h3>
          <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-sm">{Object.entries(candidate.genome).map(([key, value]) => <div key={key} className="contents"><dt className={cn('text-foreground-muted', key !== 'cta' && 'capitalize')}>{key === 'cta' ? 'CTA' : key}</dt><dd className="text-foreground-light">{value}</dd></div>)}</dl>
        </div>
        <h3 className="label" title={scoreDisplay(candidate).title}>{scoreLabel(candidate)} · {scoreDisplay(candidate).value} {scoreDisplay(candidate).unit}</h3>
        {review && <section className="flex flex-col gap-2">
          <h3 className="label">Media review</h3>
          <ScoreRow label="Quality" value={review.quality} /><ScoreRow label="Brief alignment" value={review.briefAlignment} />
          <p className="text-xs text-foreground-lighter">{review.passed ? 'Passed automated checks.' : 'Review checks failed.'} {review.evidenceScope === 'six-sampled-frames-and-audio-transcript' ? 'Video review uses six sampled frames and an audio transcript; it cannot assess every moment or motion smoothness.' : 'Still-image review.'}</p>
          <ul className="text-xs text-foreground-light">{Object.entries(review.checks).map(([name, passed]) => <li key={name}>{name.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`)}: {passed ? 'pass' : 'fail'}</li>)}</ul>
          <p className="text-xs text-foreground-lighter">{review.reasons.join(' · ')}</p>
          <details className="text-xs text-foreground-light"><summary>Observed copy and transcript</summary><p className="mt-2">{review.observedText}</p><p>{review.transcript || 'No audio transcript.'}</p></details>
        </section>}
        {neural?.source === 'tribe-neural' && <section className="flex flex-col gap-3" aria-label="Neural scores">
          <h3 className="label">Neural overall · {score(neural.engagementScore)} / 100</h3>
          <p className="text-xs text-foreground-lighter">Original: {originalLabel || 'first shortlisted creative'}. Every take uses the same baseline.</p>
          {neural.regions?.map(region => <div key={region.key}>
            <ScoreRow label={region.name} value={region.score} />
            <svg viewBox="0 0 240 60" className="mt-1 h-14 w-full" role="img" aria-label={`${region.name} over time`}>
              <path d="M0 30H240" stroke="currentColor" opacity="0.2" />
              <polyline fill="none" stroke={region.color || 'currentColor'} strokeWidth="2" points={region.values.map((v, i) => `${240 * i / Math.max(1, region.values.length - 1)},${60 - clamp(v) * .6}`).join(' ')} />
            </svg>
          </div>)}
          <p className="text-xs text-foreground-lighter">Four equally weighted Glasser families. 50 is the zero-z midpoint. Predicted cortical response is not validated emotion or ad effectiveness. {neural.provenance}</p>
        </section>}
        {!review && neural?.source !== 'tribe-neural' && <p className="text-xs text-foreground-lighter">Historical scores remain in the run export.</p>}
        <div><h3 className="label">Where this came from</h3><p className="text-xs text-foreground-lighter">Round {candidate.round} · {candidate.mutation}<br />{candidate.parents.length ? `Parent nodes: ${candidate.parents.join(', ')}` : 'Initial population'}</p></div>
        {candidate.asset?.prompt && <details className="text-xs"><summary className="focus-ring cursor-pointer text-foreground-light">Render prompt</summary><p className="mt-2 text-foreground-lighter">{candidate.asset.prompt}</p></details>}
      </div>
    </div>}
  </Dialog>;
}
