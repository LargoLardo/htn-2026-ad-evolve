import type { Candidate, Run } from './types';

export const selectionScore = (candidate: Candidate) =>
  candidate.scores?.neural?.source === 'tribe-percept'
    ? candidate.scores.neural.engagementScore
    : candidate.scores?.fitness;
export const scoreLabel = (candidate: Candidate) => candidate.scores?.source === 'tribe-percept'
  ? 'Percept overall' : candidate.scores?.review ? 'Media review only' : 'Historical score';
export const isPercept = (run: Run) => run.neuralConfig?.version?.startsWith('percept-') || run.rounds.some(r => r.candidates.some(c => c.scores?.source === 'tribe-percept'));
export const compareCandidates = (a: Candidate, b: Candidate) => {
  const tier = (c: Candidate) => c.scores?.eligible && c.scores?.neural ? 2 : c.provisional ? 1 : 0;
  return tier(b) - tier(a) || (selectionScore(b) ?? -1) - (selectionScore(a) ?? -1);
};
