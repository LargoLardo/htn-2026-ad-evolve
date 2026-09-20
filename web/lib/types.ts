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
  | 'awaiting-selection'
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
  mediaType?: 'image' | 'video';
  videoDuration?: number;
  aspectRatio?: '9:16' | '16:9' | '1:1';
  originalMediaId?: string | null;
  originalAsset?: Asset;
  selectionPolicy?: 'auto' | 'manual';
  feedbackEveryRound?: boolean;
}

export interface MediaReview {
  quality: number;
  briefAlignment: number;
  passed: boolean;
  observedText: string;
  transcript?: string;
  evidenceScope?: string;
  reasons: string[];
  checks: Record<string, boolean>;
}

export interface NeuralScore {
  source: string;
  engagementScore?: number;
  provenance: string;
  regions?: { key: string; name: string; score: number; color: string; values: number[] }[];
  /** Length of each region trace, and the stimulus seconds it covers. */
  frames?: number;
  duration?: number;
  /** Each Glasser parcel's own trace, before its family averages them. Absent on
   *  runs scored before per-parcel traces existed. */
  parcels?: { key: string; name: string; values: number[] }[];
}

export interface Scores {
  fitness: number | null;
  source: string;
  provenance?: string;
  confidence?: number | null;
  eligible?: boolean;
  review?: MediaReview;
  neural?: NeuralScore | null;
}

export interface Genome {
  hook: string;
  visual: string;
  emotion: string;
  proof: string;
  cta: string;
  palette: string;
  motion?: string;
  audio?: string;
}

export interface Asset {
  url: string;
  prompt: string;
  kind: string;
  mediaHash?: string;
  mediaType?: "image" | "video";
  duration?: number;
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
  provisional?: boolean;
  original?: boolean;
  killed?: boolean;
  mutation: string;
}

export interface RoundData {
  number: number;
  candidates: Candidate[];
  best: number | null;
  mean: number | null;
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
  /** Rounds retaining provisional drafts when all reviews failed. */
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
  requiresReview?: boolean;
  neuralConfig?: { version: string; hash: string };
  neuralBaseline?: { candidateId: string; choice: string; mediaHash: string };
  gate?: { token: string; round: number; status: 'pending' | 'submitted' | 'resolved'; eligibleIds: string[]; suggestedIds: string[]; note: string } | null;
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
  durableRuns?: boolean;
  attentionMaps?: boolean;
  liveResearch: boolean;
  liveImages: boolean;
  liveVideos: boolean;
  videoModel: string;
  /** Percept scoring requires the updated worker endpoint. */
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
