import type { Candidate, Run } from './types';

export const hasNeural = (candidate: Candidate) => candidate.scores?.neural?.source === 'tribe-percept';

export const selectionScore = (candidate: Candidate) =>
  hasNeural(candidate) ? candidate.scores!.neural!.engagementScore : candidate.scores?.fitness;

/** Percept is centred on 50, where 50 means "identical to the original creative". */
export const PERCEPT_PARITY = 50;

/**
 * How a candidate's score should read, given the two scales are not comparable.
 *
 * Percept's engagementScore is a deviation from the original creative; the
 * review fitness is a 0-100 craft rubric where 60 is minimally acceptable. Shown
 * as two bare numbers they look like the same measurement, so a 55 Percept take
 * (better than the original) reads as worse than a 78 review-only draft (merely
 * decent craft). Percept is therefore rendered signed and relative, which no
 * craft score ever is.
 */
export function scoreDisplay(candidate: Candidate): { value: string; unit: string; title: string } {
  const raw = selectionScore(candidate);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { value: '-', unit: '', title: 'Not scored' };
  }
  if (hasNeural(candidate)) {
    const delta = raw - PERCEPT_PARITY;
    return {
      value: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
      unit: 'vs original',
      title: `Percept ${raw.toFixed(1)} / 100, where ${PERCEPT_PARITY} is identical to the original creative. Predicted cortical response, not measured emotion.`,
    };
  }
  return {
    value: raw.toFixed(1),
    unit: 'craft',
    title: 'Media review only: image quality and brief alignment, 0-100. 60 is minimally acceptable, 80 is strong. Never reached neural scoring.',
  };
}

export const scoreLabel = (candidate: Candidate) => hasNeural(candidate)
  ? 'Percept vs original' : candidate.scores?.review ? 'Media review only' : 'Historical score';

export const isPercept = (run: Run) => run.neuralConfig?.version?.startsWith('percept-') || run.rounds.some(r => r.candidates.some(c => c.scores?.source === 'tribe-percept'));

/**
 * Mirrors compareCandidates in lib/evolution.mjs: separate tiers, never a
 * subtraction across the two scales.
 */
export const compareCandidates = (a: Candidate, b: Candidate) => {
  const tier = (c: Candidate) => c.scores?.eligible && c.scores?.neural ? 2 : c.provisional ? 1 : 0;
  const byTier = tier(b) - tier(a);
  if (byTier) return byTier;
  const neuralA = hasNeural(a), neuralB = hasNeural(b);
  if (neuralA !== neuralB) return neuralA ? -1 : 1;
  return (selectionScore(b) ?? -1) - (selectionScore(a) ?? -1);
};
