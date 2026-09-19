'use client';

import { Download } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { assetLink } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EMOTIONS, type Candidate } from '@/lib/types';

const score = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : '-';

const clamp = (value?: number | null) =>
  Math.min(100, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0));

export default function CreativeInspector({
  candidate,
  product,
  onClose,
}: {
  candidate: Candidate | null;
  product: string;
  onClose: () => void;
}) {
  const src = assetLink(candidate?.asset?.url);
  const slug = product.replace(/[^a-z0-9]/gi, '-');

  return (
    <Dialog open={!!candidate} onClose={onClose} label="Creative inspector">
      {candidate && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_1.2fr]">
          <div className="flex flex-col gap-3">
            {src ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={candidate.headline}
                  className="w-full rounded-lg border border-border"
                />
                <a
                  href={src}
                  download={`${slug}-${candidate.id}.${src.split('.').at(-1)}`}
                  className="focus-ring inline-flex items-center justify-center gap-2 rounded-md border border-border-button bg-surface-100 px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-200"
                >
                  <Download size={14} /> Download draft
                </a>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-foreground-lighter">
                This concept was screened without rendering an image.
              </div>
            )}
            <p className="text-xs text-foreground-lighter">
              {src
                ? candidate.scores?.source === 'tribe-calibrated'
                  ? 'TRIBE evaluated this exact image under the worker presentation protocol.'
                  : 'The heuristic scores the text genome. This image illustrates the concept.'
                : ''}
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-2xl text-foreground">{candidate.headline}</h2>
              <p className="text-sm text-foreground-light">{candidate.body}</p>
              <span className="w-fit rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground-lighter">
                CTA · {candidate.cta}
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="label">Creative genome</h3>
              <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-sm">
                {Object.entries(candidate.genome).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className={cn('text-foreground-muted', key !== 'cta' && 'capitalize')}>
                      {key === 'cta' ? 'CTA' : key}
                    </dt>
                    <dd className="text-foreground-light">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="label">
                Fitness {score(candidate.scores?.fitness)} / 100
              </h3>
              {EMOTIONS.map((emotion) => (
                <div key={emotion} className="grid grid-cols-[72px_1fr_28px] items-center gap-2">
                  <span className="text-xs capitalize text-foreground-light">{emotion}</span>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-border-muted">
                    <i
                      className="block h-full rounded-full bg-brand"
                      style={{ width: `${clamp(candidate.scores?.[emotion])}%` }}
                    />
                  </div>
                  <span className="text-right text-xs tabular-nums text-foreground-lighter">
                    {score(candidate.scores?.[emotion])}
                  </span>
                </div>
              ))}
              <p className="text-xs text-foreground-lighter">
                {candidate.scores?.provenance}
                {candidate.scores?.confidence == null && ' · Uncertainty not estimated.'}
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <h3 className="label">Where this came from</h3>
              <p className="text-xs text-foreground-lighter">
                Generation {candidate.round} · {candidate.mutation}
                <br />
                {candidate.parents.length
                  ? `Parents: ${candidate.parents.join(', ')}`
                  : 'Initial population'}
              </p>
            </div>

            {candidate.asset?.prompt && (
              <details className="text-xs">
                <summary className="focus-ring cursor-pointer text-foreground-light">
                  Render prompt
                </summary>
                <p className="mt-2 text-foreground-lighter">{candidate.asset.prompt}</p>
              </details>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
