'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { createRun, errorMessage } from '@/lib/api';
import { EMOTIONS, type Brief, type Config, type Emotion, type Run } from '@/lib/types';
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
  const [mode, setMode] = useState<Brief['mode']>(initial?.mode ?? 'demo');
  const [scorer, setScorer] = useState<Brief['scorer']>(initial?.scorer ?? 'proxy');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The server rejects shortlist > population, so keep the control honest rather
  // than letting the user compose a request that can only 400.
  useEffect(() => {
    setShortlist((current) => Math.min(current, population));
  }, [population]);

  const liveAvailable = !!config?.liveResearch;
  const tribeAvailable = !!config?.tribe;

  useEffect(() => {
    if (!liveAvailable && mode === 'live') setMode('demo');
  }, [liveAvailable, mode]);

  useEffect(() => {
    // TRIBE scores real rendered media, so it is only meaningful in live mode.
    if ((mode !== 'live' || !tribeAvailable) && scorer === 'tribe') setScorer('proxy');
  }, [mode, scorer, tribeAvailable]);

  const budget = useMemo(
    () => rounds * population,
    [rounds, population]
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || disabled) return;
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
      mode,
      scorer,
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

  const locked = submitting || disabled;

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
        Screens up to {budget} concepts across {rounds} generation{rounds === 1 ? '' : 's'}.
      </p>

      <details className="group border-t border-border pt-4">
        <summary className="focus-ring flex cursor-pointer list-none items-center justify-between text-sm text-foreground-light">
          Advanced
          <span className="transition-transform group-open:rotate-45">+</span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-mode`} className="text-sm text-foreground-light">
              Generation
            </label>
            <select
              id={`${uid}-mode`}
              value={mode}
              disabled={locked}
              onChange={(event) => setMode(event.target.value as Brief['mode'])}
              className={field}
            >
              <option value="demo">Demo · local illustrations</option>
              <option value="live" disabled={!liveAvailable}>
                Live · {liveAvailable ? 'uses your API key' : 'connect an API key'}
              </option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-scorer`} className="text-sm text-foreground-light">
              Scoring
            </label>
            <select
              id={`${uid}-scorer`}
              value={scorer}
              disabled={locked}
              onChange={(event) => setScorer(event.target.value as Brief['scorer'])}
              className={field}
            >
              <option value="proxy">Design heuristic · clearly labelled proxy</option>
              <option value="tribe" disabled={!tribeAvailable || mode !== 'live'}>
                TRIBE · {tribeAvailable ? 'requires live mode' : 'worker not configured'}
              </option>
            </select>
          </div>
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
        {mode === 'live'
          ? 'Live mode makes paid API calls. A provider failure stops the run.'
          : 'Demo mode runs offline with local illustrations and a heuristic score.'}
      </p>
    </form>
  );
}
