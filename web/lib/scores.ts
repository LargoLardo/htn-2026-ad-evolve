import type { Candidate, Run } from './types';

export const hasNeural = (candidate: Candidate) => candidate.scores?.neural?.source === 'tribe-neural';

export const selectionScore = (candidate: Candidate) =>
  hasNeural(candidate) ? candidate.scores!.neural!.engagementScore : candidate.scores?.fitness;

const NEURAL_PARITY = 50;

export function scoreDisplay(candidate: Candidate): { value: string; unit: string; title: string } {
  const raw = selectionScore(candidate);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { value: '-', unit: '', title: 'Not scored' };
  }
  if (hasNeural(candidate)) {
    const delta = raw - NEURAL_PARITY;
    return {
      value: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
      unit: 'vs original',
      title: `Neural ${raw.toFixed(1)} / 100, where ${NEURAL_PARITY} is identical to the original creative. Predicted cortical response, not measured emotion.`,
    };
  }
  return {
    value: raw.toFixed(1),
    unit: 'craft',
    title: 'Media review only: image quality and brief alignment, 0-100. 60 is minimally acceptable, 80 is strong. Never reached neural scoring.',
  };
}

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
      ? `Media review only: ${craft.toFixed(1)} / 100 for craft and brief alignment, where 60 is minimally acceptable and 80 is strong. Not shortlisted for neural scoring.`
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
    parityPercent: NEURAL_PARITY,
  };
}

export const scoreLabel = (candidate: Candidate) => hasNeural(candidate)
  ? 'Neural vs original' : candidate.scores?.review ? 'Media review only' : 'Historical score';

export const isNeural = (run: Run) => run.neuralConfig?.version?.startsWith('neural-') || run.rounds.some(r => r.candidates.some(c => c.scores?.source === 'tribe-neural'));

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
