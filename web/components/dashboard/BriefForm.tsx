'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { createRun, errorMessage, uploadMedia } from '@/lib/api';
import { EMOTIONS, type Brief, type Config, type Emotion, type Run } from '@/lib/types';
import MediaPreview from './MediaPreview';
import { cn } from '@/lib/utils';

const EMOTION_COLORS: Record<Emotion, string> = {
  joy: '#d8b484',
  trust: '#9eb68e',
  curiosity: '#b6a2ca',
  desire: '#d0a895',
};

const DEFAULT_WEIGHTS: Record<Emotion, number> = {
  joy: 30,
  trust: 20,
  curiosity: 35,
  desire: 15,
};

const field =
  'w-full rounded-md border border-border-control bg-control px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-brand-highlight';

/** `initial` repopulates the form when a saved run is opened, the way fillBrief()
 *  did. Mount this with a key tied to the run id so the uncontrolled text fields
 *  pick up new defaultValues. */
export default function BriefForm({
  config,
  disabled,
  initial,
  onStarted,
}: {
  config: Config | null;
  disabled: boolean;
  initial?: Brief | null;
  onStarted: (run: Run) => void;
}) {
  const uid = useId();
  const [weights, setWeights] = useState(initial?.weights ?? DEFAULT_WEIGHTS);
  const [rounds, setRounds] = useState(initial?.rounds ?? 3);
  const [population, setPopulation] = useState(initial?.population ?? 8);
  const [shortlist, setShortlist] = useState(initial?.shortlist ?? 3);
  const [mediaType, setMediaType] = useState(initial?.mediaType ?? 'image');
  const [original, setOriginal] = useState(initial?.originalAsset && initial.originalMediaId ? { id: initial.originalMediaId, asset: initial.originalAsset } : null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The server rejects shortlist > population, so keep the control honest rather
  // than letting the user compose a request that can only 400.
  useEffect(() => {
    setShortlist((current) => Math.min(current, population));
  }, [population]);

  const budget = useMemo(
    () => rounds * population,
    [rounds, population]
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || disabled || uploading) return;
    setError(null);

    if (!Object.values(weights).some(Boolean)) {
      setError('Choose at least one emotional priority above zero.');
      return;
    }

    const data = new FormData(event.currentTarget);
    const brief: Brief = {
      product: String(data.get('product') ?? '').trim(),
      description: String(data.get('description') ?? '').trim(),
      audience: String(data.get('audience') ?? '').trim(),
      goal: String(data.get('goal') ?? '').trim(),
      weights,
      rounds,
      population,
      shortlist,
      seed: Number(data.get('seed') ?? 0) || 0,
      mode: 'live',
      scorer: 'tribe',
      mediaType,
      videoDuration: Number(data.get('videoDuration') || 10),
      aspectRatio: (data.get('aspectRatio') || '9:16') as Brief['aspectRatio'],
      originalMediaId: original?.id ?? null,
    };

    setSubmitting(true);
    try {
      onStarted(await createRun(brief));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const locked = submitting || disabled || uploading;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h2 className="text-xl text-foreground">Brief</h2>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-product`} className="text-sm text-foreground-light">
          Product name
        </label>
        <input
          id={`${uid}-product`}
          name="product"
          required
          maxLength={100}
          defaultValue={initial?.product ?? ''}
          disabled={locked}
          placeholder="e.g. PULSE"
          className={field}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-description`} className="text-sm text-foreground-light">
          What makes it different?
        </label>
        <textarea
          id={`${uid}-description`}
          name="description"
          required
          minLength={3}
          rows={2}
          maxLength={4000}
          defaultValue={initial?.description ?? ''}
          disabled={locked}
          placeholder="e.g. A botanical sparkling water with bright citrus, no added sugar."
          className={cn(field, 'resize-y')}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-audience`} className="text-sm text-foreground-light">
          Who is it for?
        </label>
        <input
          id={`${uid}-audience`}
          name="audience"
          maxLength={500}
          defaultValue={initial?.audience ?? ''}
          disabled={locked}
          placeholder="e.g. Creative professionals looking for an afternoon reset"
          className={field}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-goal`} className="text-sm text-foreground-light">
          What should the ad achieve?
        </label>
        <textarea
          id={`${uid}-goal`}
          name="goal"
          required
          rows={2}
          maxLength={800}
          defaultValue={initial?.goal ?? ''}
          disabled={locked}
          placeholder="e.g. Make an everyday break feel refreshing and desirable."
          className={cn(field, 'resize-y')}
        />
      </div>

      <fieldset className="flex flex-col gap-2 border-t border-border pt-4">
        <legend className="sr-only">Emotional priorities</legend>
        <p className="text-xs text-foreground-lighter">Creative direction only; these priorities do not change the neural score.</p>
        {EMOTIONS.map((emotion) => (
          <div key={emotion} className="grid grid-cols-[14px_72px_1fr_28px] items-center gap-2">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: EMOTION_COLORS[emotion] }}
            />
            <label htmlFor={`${uid}-w-${emotion}`} className="text-sm capitalize text-foreground-light">
              {emotion}
            </label>
            <input
              id={`${uid}-w-${emotion}`}
              type="range"
              min={0}
              max={100}
              value={weights[emotion]}
              disabled={locked}
              onChange={(event) =>
                setWeights((current) => ({ ...current, [emotion]: Number(event.target.value) }))
              }
              className="h-[3px] w-full accent-brand"
            />
            <output className="text-right text-xs tabular-nums text-foreground-lighter">
              {weights[emotion]}
            </output>
          </div>
        ))}
      </fieldset>

      <div className="grid grid-cols-3 gap-3 border-t border-border pt-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-rounds`} className="text-sm text-foreground-light">
            Rounds
          </label>
          <input
            id={`${uid}-rounds`}
            type="number"
            min={1}
            max={config?.limits.rounds ?? 6}
            value={rounds}
            disabled={locked}
            onChange={(event) => setRounds(Number(event.target.value))}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-population`} className="text-sm text-foreground-light">
            Per round
          </label>
          <input
            id={`${uid}-population`}
            type="number"
            min={4}
            max={config?.limits.population ?? 16}
            value={population}
            disabled={locked}
            onChange={(event) => setPopulation(Number(event.target.value))}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-shortlist`} className="text-sm text-foreground-light">
            Shortlist
          </label>
          <input
            id={`${uid}-shortlist`}
            type="number"
            min={1}
            max={population}
            value={shortlist}
            disabled={locked}
            onChange={(event) => setShortlist(Number(event.target.value))}
            className={field}
          />
        </div>
      </div>

      <p className="text-xs text-foreground-lighter">
        Up to {budget} media drafts and {rounds * shortlist} neural shortlist slots{original ? ', plus one original baseline evaluation' : ''}.
      </p>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <label htmlFor={`${uid}-mediaType`} className="text-sm text-foreground-light">Ad format</label>
        <select id={`${uid}-mediaType`} value={mediaType} disabled={locked} className={field}
          onChange={event => { setMediaType(event.target.value as 'image' | 'video'); setOriginal(null); }}>
          <option value="image">Image ad</option><option value="video">Video ad · Seedance 2.0</option>
        </select>
        {mediaType === 'video' && <div className="grid grid-cols-2 gap-3">
          <div><label htmlFor={`${uid}-duration`} className="text-sm text-foreground-light">Video seconds</label>
            <input id={`${uid}-duration`} name="videoDuration" type="number" min={4} max={15} defaultValue={initial?.videoDuration ?? 10} disabled={locked} required className={field} /></div>
          <div><label htmlFor={`${uid}-aspect`} className="text-sm text-foreground-light">Aspect ratio</label>
            <select id={`${uid}-aspect`} name="aspectRatio" defaultValue={initial?.aspectRatio ?? '9:16'} disabled={locked} className={field}>
              <option value="9:16">Portrait 9:16</option><option value="16:9">Landscape 16:9</option><option value="1:1">Square 1:1</option>
            </select></div>
        </div>}
        <label htmlFor={`${uid}-original`} className="text-sm text-foreground-light">Original ad (optional)</label>
        <input key={mediaType} id={`${uid}-original`} type="file" accept={mediaType === 'video' ? 'video/mp4' : 'image/png,image/jpeg,image/webp'} disabled={locked} className={field}
          onChange={async event => {
            const input = event.currentTarget, file = input.files?.[0]; if (!file) return;
            setUploading(true); setError(null);
            try { const result = await uploadMedia(file); if (result.asset.mediaType !== mediaType) throw new Error('Original must match the selected ad format.'); setOriginal(result); }
            catch (caught) { setError(errorMessage(caught)); }
            finally { setUploading(false); input.value = ''; }
          }} />
        <p className="text-xs text-foreground-lighter">Images become 10-second videos for TRIBE. MP4 uploads: 1–60 seconds, up to 50 MiB. Every take uses the same original baseline.</p>
        {uploading && <p role="status">Uploading and checking media…</p>}
        {original && <div className="flex flex-col gap-2">
          <MediaPreview asset={original.asset} title="Original ad" className="max-h-48 w-full rounded-md object-contain" />
          <p className="text-xs text-foreground-lighter">Original uploaded and saved.</p>
          <Button type="button" disabled={locked} onClick={() => setOriginal(null)}>Remove original</Button>
        </div>}
        <p className="text-xs text-foreground-lighter">Percept overall score: four equally weighted Glasser families, measuring the magnitude of the predicted cortical response against the original. Selection takes the largest among reviewed takes; if all fail, provisional drafts remain visible. A larger predicted response is not by itself evidence of a better ad.</p>
      </div>

      <details className="group border-t border-border pt-4">
        <summary className="focus-ring flex cursor-pointer list-none items-center justify-between text-sm text-foreground-light">
          Advanced
          <span className="transition-transform group-open:rotate-45">+</span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-seed`} className="text-sm text-foreground-light">
              Seed
            </label>
            <input
              id={`${uid}-seed`}
              name="seed"
              type="number"
              min={0}
              max={2147483647}
              defaultValue={initial?.seed ?? 0}
              disabled={locked}
              className={field}
            />
          </div>
        </div>
      </details>

      {error && (
        <p role="alert" className="rounded-md border border-destructive-500 bg-destructive-200 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" size="large" disabled={locked} className="w-full">
        {submitting ? 'Starting…' : disabled ? 'Run in progress' : 'Start evolution'}
      </Button>

      <p className="text-xs text-foreground-lighter">
        {mediaType === 'video' ? 'Seedance/Pika generates videos; OpenAI researches and reviews.' : 'OpenAI generates and reviews images.'} TRIBE scores shortlisted takes. Paid API calls.
      </p>
    </form>
  );
}
