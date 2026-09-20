'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { type Run } from '@/lib/types';
import MediaPreview from './MediaPreview';

export default function RoundGate({ run, gate }: { run: Run; gate: NonNullable<Run['gate']> }) {
  const [parents, setParents] = useState(gate.suggestedIds);
  const [removed, setRemoved] = useState<string[]>([]);
  const [note, setNote] = useState(gate.note);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const locked = busy || submitted || gate.status !== 'pending';
  const candidates = run.rounds.find(round => round.number === gate.round)?.candidates.filter(c => gate.eligibleIds.includes(c.id)) ?? [];
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];

  async function submit() {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/runs/${run.id}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: gate.token, round: gate.round, parentIds: parents, killedIds: removed, note }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save your selection.');
      setSubmitted(true);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  return <section aria-label="Round selection" className="flex flex-col gap-4 rounded-lg border border-brand bg-surface-100 p-5">
    <h2 className="text-lg">Round {gate.round}: choose 1–4 parent nodes</h2>
    <p className="text-sm text-foreground-lighter">The run is saved and will resume after your selection. Removed nodes cannot become finalists. At least one parent must remain.</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {candidates.map(candidate => <article key={candidate.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
        {candidate.asset && <MediaPreview asset={candidate.asset} title={candidate.headline} className="h-32 w-full rounded object-contain" />}
        <p className="text-sm">{candidate.headline}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={parents.includes(candidate.id)} disabled={locked || removed.includes(candidate.id) || (!parents.includes(candidate.id) && parents.length >= 4)} onChange={() => setParents(toggle(parents, candidate.id))} />Use as parent</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={removed.includes(candidate.id)} disabled={locked || parents.includes(candidate.id)} onChange={() => setRemoved(toggle(removed, candidate.id))} />Remove from selection</label>
      </article>)}
    </div>
    <label className="flex flex-col gap-2 text-sm">Direction for the next round
      <textarea value={note} onChange={event => setNote(event.target.value)} maxLength={8000} rows={3} disabled={locked} className="rounded border border-border bg-control p-3" />
    </label>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button type="button" variant="primary" disabled={locked || parents.length < 1 || parents.length > 4} onClick={submit}>{locked ? 'Saving selection and resuming…' : 'Save selection and continue'}</Button>
  </section>;
}
