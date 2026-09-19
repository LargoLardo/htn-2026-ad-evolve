// Shapes produced by lib/evolution.mjs and lib/providers.mjs. The vanilla client
// consumed these untyped; writing them down is the one place the frontend gets to
// state what it actually depends on.

export type Emotion = 'joy' | 'trust' | 'curiosity' | 'desire';

export const EMOTIONS: Emotion[] = ['joy', 'trust', 'curiosity', 'desire'];

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export type RunStage =
  | 'queued'
  | 'research'
  | 'generating'
  | 'screening'
  | 'rendering'
  | 'scoring'
  | 'evolving'
  | 'finalizing'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type Mode = 'demo' | 'live';
export type Scorer = 'proxy' | 'tribe';

export interface Brief {
  product: string;
  description: string;
  audience: string;
  goal: string;
  weights: Record<Emotion, number>;
  rounds: number;
  population: number;
  shortlist: number;
  seed: number;
  mode: Mode;
  scorer: Scorer;
}

export interface Scores extends Record<Emotion, number> {
  fitness: number;
  proxyFitness: number;
  source: 'heuristic' | 'tribe-calibrated';
  provenance: string;
  confidence: number | null;
}

export interface Genome {
  hook: string;
  visual: string;
  emotion: string;
  proof: string;
  cta: string;
  palette: string;
}

export interface Asset {
  url: string;
  prompt: string;
  kind: string;
  mediaHash?: string;
}

export interface Candidate {
  id: string;
  round: number;
  parents: string[];
  genome: Genome;
  headline: string;
  body: string;
  cta: string;
  asset: Asset | null;
  scores: Scores | null;
  selected: boolean;
  mutation: string;
}

export interface RoundData {
  number: number;
  candidates: Candidate[];
  best: number;
  mean: number;
  selectedIds: string[];
  evaluated: number;
}

export interface Insight {
  title: string;
  detail: string;
  kind: string;
  sourceUrls: string[];
}

export interface Research {
  summary: string;
  insights: Insight[];
  sources: { title: string; url: string }[];
  provenance: string;
}

export interface Metrics {
  generated: number;
  cacheHits: number;
  tribeCalls: number;
  tribeCandidates: number;
  rendered: number;
  /** Candidates put through the multimodal render review. */
  reviewed: number;
  /** Of those, how many the reviewer rejected. */
  rejected: number;
  /** Rounds that shortlisted on provisional scores while inference caught up. */
  provisionalRounds: number;
  elapsedMs: number;
}

export interface Run {
  id: string;
  status: RunStatus;
  stage: RunStage;
  brief: Brief;
  research: Research | null;
  rounds: RoundData[];
  finalists: Candidate[];
  events: { time: string; message: string }[];
  metrics: Metrics;
  createdAt: string;
  error?: string;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  stage: RunStage;
  product: string;
  createdAt: string;
  metrics: Metrics;
}

export interface Config {
  liveResearch: boolean;
  liveImages: boolean;
  /** Experimental TRIBE pattern scoring: needs a feature endpoint AND a frozen reference. */
  tribe: boolean;
  /** Multimodal review of rendered images before they are scored. */
  visualScreening: boolean;
  textModel: string;
  imageModel: string;
  screenModel: string;
  tribeDecoder: string | null;
  /** Decoder training is deliberately paused; surfaced so the UI cannot imply otherwise. */
  decoderTraining: string;
  tribeStatus: string;
  limits: {
    rounds: number;
    population: number;
    activeRuns: number;
    maxBodyBytes: number;
  };
}
