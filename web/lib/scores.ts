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

/**
 * The compact form, for a graph node with room for one number and no caption.
 *
 * scoreDisplay labels the two scales so they cannot be mistaken for each other,
 * which is enough where there is room to print the unit beside the figure. On a
 * node in the lineage tree there is not: a craft 94.0 sitting next to a Percept
 * -46.4 reads as the higher one winning, when the craft-only candidate never
 * entered the race at all. Only the shortlist of three per generation is ever
 * scored by Percept, because one call costs about two minutes of GPU time.
 *
 * So a node carries a number only when Percept actually measured it. Everything
 * else says so plainly and keeps its craft score in the tooltip, where the
 * label can explain what it is.
 */
export function nodeScore(candidate: Candidate): { value: string | null; unit: string; title: string } {
  if (hasNeural(candidate)) {
    const { value, unit, title } = scoreDisplay(candidate);
    return { value, unit, title };
  }
  const craft = candidate.scores?.fitness;
  return {
    value: null,
    unit: 'not scored',
    title: typeof craft === 'number' && Number.isFinite(craft)
      ? `Media review only: ${craft.toFixed(1)} / 100 for craft and brief alignment, where 60 is minimally acceptable and 80 is strong. It was not shortlisted, so Percept never scored it.`
      : 'Never scored.',
  };
}

/**
 * The score as a position on a fixed 0-100 scale, with the original marked.
 *
 * A delta ("-46.4 vs original") asks the reader to know that parity is 50 and
 * that down is worse, and it puts a minus sign next to element verdicts where
 * a minus sign means the opposite. A bar with the original ticked needs no
 * explanation at all: further right is better, and you can see where the ad
 * you uploaded sits.
 */
export function nodeScoreBar(candidate: Candidate): { score: number; percent: number; parityPercent: number } | null {
  if (!hasNeural(candidate)) return null;
  const score = candidate.scores?.neural?.engagementScore;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return {
    score,
    percent: Math.max(0, Math.min(100, score)),
    parityPercent: PERCEPT_PARITY,
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
