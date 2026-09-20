import { createHash, randomUUID } from 'node:crypto';
import { validateScreen } from './providers.mjs';

export const EMOTIONS = ['joy', 'trust', 'curiosity', 'desire'];
export const LIMITS = { rounds: 6, population: 16, activeRuns: 2, maxBodyBytes: 24_000 };
const GENES = ['hook', 'visual', 'emotion', 'proof', 'cta', 'palette', 'motion', 'audio'];
const POOLS = {
  hook: ['A small everyday transformation', 'A surprising question', 'A moment of shared delight', 'A clear practical benefit', 'A fresh perspective'],
  visual: ['Product in a quiet daily ritual', 'Bold editorial product close-up', 'An illustrated before-and-after moment', 'Human-centered lifestyle scene', 'Minimal product silhouette'],
  emotion: ['joy', 'trust', 'curiosity', 'desire'],
  proof: ['Explain the product plainly', 'Show how it fits a daily routine', 'Demonstrate one described feature', 'Invite the audience to explore details'],
  cta: ['Explore the details', 'Meet your next favorite', 'Find your everyday upgrade', 'See how it works'],
  palette: ['coral cream', 'sage ivory', 'electric lavender', 'midnight amber', 'ocean blue'],
  motion: ['A deliberate product reveal', 'A human demonstration with two clear beats', 'A slow push-in and a crisp closing frame', 'A playful transition into the product'],
  audio: ['Warm concise voiceover and subtle music', 'Product sounds and a brief spoken CTA', 'Upbeat music under a clear factual message', 'Quiet ambient sound with restrained narration'],
};

export function validateBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provide a product brief.');
  const string = (key, min, max, fallback = '') => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new Error(`${key} must be ${min}–${max} characters.`);
    return value.trim();
  };
  const integer = (key, fallback, min, max) => {
    const value = input[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const mode = input.mode ?? 'live', scorer = input.scorer ?? 'tribe';
  if (mode !== 'live' || scorer !== 'tribe') throw new Error('The previous heuristic/demo scorer has been removed. Use live generation with Percept scoring.');
  const mediaType = input.mediaType ?? 'image';
  if (!['image', 'video'].includes(mediaType)) throw new Error('Choose image or video ads.');
  const aspectRatio = input.aspectRatio ?? '9:16';
  if (!['9:16', '16:9', '1:1'].includes(aspectRatio)) throw new Error('Choose a supported video aspect ratio.');
  const originalMediaId = input.originalMediaId || null;
  if (originalMediaId !== null && (typeof originalMediaId !== 'string' || !/^[a-f0-9]{64}$/.test(originalMediaId))) throw new Error('Invalid original media ID.');
  const weights = Object.fromEntries(EMOTIONS.map(key => [key, input.weights?.[key] ?? 25]));
  if (Object.values(weights).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) || !Object.values(weights).some(Boolean)) throw new Error('Emotion weights must be 0–100, with at least one positive weight.');
  const population = integer('population', 8, 4, LIMITS.population);
  return {
    product: string('product', 1, 100), description: string('description', 3, 4_000),
    audience: string('audience', 0, 800, 'People interested in this product'),
    goal: string('goal', 1, 800, 'Introduce the product and encourage discovery'),
    weights, rounds: integer('rounds', 3, 1, LIMITS.rounds), population,
    shortlist: integer('shortlist', 3, 1, population), seed: integer('seed', 42, 0, 2_147_483_647), mode, scorer, mediaType, aspectRatio, originalMediaId, videoDuration: integer('videoDuration', 10, 4, 15),
  };
}

export function createRun(brief) {
  return {
    id: randomUUID(), status: 'running', stage: 'queued', brief, research: null, rounds: [], finalists: [], events: [],
    metrics: { generated: 0, cacheHits: 0, tribeCalls: 0, tribeCandidates: 0, rendered: 0, reviewed: 0, rejected: 0, provisionalRounds: 0, elapsedMs: 0 },
    createdAt: new Date().toISOString(),
  };
}

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

const roundNumber = value => Math.round(value * 10) / 10;
const pick = (values, random) => values[Math.floor(random() * values.length)];
const distance = (a, b) => GENES.filter(key => a.genome[key] !== b.genome[key]).length / GENES.length;
export const fingerprint = candidate => createHash('sha256').update(JSON.stringify([candidate.genome, candidate.headline, candidate.body, candidate.cta])).digest('hex');
export const hasNeural = candidate => candidate.scores.neural?.source === 'tribe-percept';
export const selectionScore = candidate => hasNeural(candidate) ? candidate.scores.neural.engagementScore : candidate.scores.fitness;

// Review determines the shortlist. Once evaluated, the shared-baseline neural
// score selects the take; exact visual score breaks neural ties only.
//
// Neural-scored and review-only candidates are ranked in separate tiers rather
// than by subtracting one selectionScore from the other, because the two are
// different scales and the difference is meaningless. Percept's
// engagementScore is centred on 50, where 50 means "identical to the original
// creative"; the review fitness is a 0-100 craft rubric where 60 is minimally
// acceptable and 80 is strong. Comparing them directly let a review-only draft
// at 78 outrank a genuinely better-than-original take at 52.
//
// Only a shortlist ever reaches Percept, so a run always contains both kinds.
export function compareCandidates(a, b) {
  const neuralA = hasNeural(a), neuralB = hasNeural(b);
  // An evaluated take outranks an unevaluated one: it cleared review and was
  // shortlisted, which is strictly more evidence.
  if (neuralA !== neuralB) return neuralA ? -1 : 1;
  if (neuralA) return selectionScore(b) - selectionScore(a) || b.scores.fitness - a.scores.fitness;
  return b.scores.fitness - a.scores.fitness;
}

function visualDistance(a, b) {
  const left = new Set(a.scores.review?.visualTags.map(tag => tag.toLowerCase()) || []);
  const right = new Set(b.scores.review?.visualTags.map(tag => tag.toLowerCase()) || []);
  if (!left.size || !right.size) return distance(a, b);
  return 1 - [...left].filter(tag => right.has(tag)).length / new Set([...left, ...right]).size;
}

function reviewFailures(candidate) {
  const review = candidate.scores.review;
  return Object.values(review.checks).filter(value => !value).length + Number(review.quality < 60) + Number(review.briefAlignment < 60);
}

function draftCopy(genome, brief) {
  const headlines = {
    'A small everyday transformation': `A little more ${brief.product}. A different kind of day.`,
    'A surprising question': `What could ${brief.product} change in your day?`,
    'A moment of shared delight': `Meet your next favorite: ${brief.product}.`,
    'A clear practical benefit': `${brief.product}, made easy to understand.`,
    'A fresh perspective': `See your everyday differently with ${brief.product}.`,
  };
  return { headline: headlines[genome.hook] ?? `Discover ${brief.product}.`, body: brief.description, cta: genome.cta };
}

function cleanConcept(concept, fallback) {
  if (!concept || typeof concept !== 'object') return fallback;
  const genome = Object.fromEntries(GENES.map(key => [key, typeof concept.genome?.[key] === 'string' && concept.genome[key].trim() ? concept.genome[key].trim().slice(0, 400) : fallback.genome[key]]));
  return { genome, ...Object.fromEntries(['headline', 'body', 'cta'].map(key => [key, typeof concept[key] === 'string' && concept[key].trim() ? concept[key].trim().slice(0, key === 'body' ? 4_000 : 400) : fallback[key]])) };
}

async function mapLimit(values, concurrency, fn, signal) {
  let cursor = 0; let failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    try {
      while (!failed && cursor < values.length) { signal?.throwIfAborted(); const item = values[cursor++]; await fn(item); }
    } catch (error) { failed = true; throw error; }
  }));
  const rejection = results.find(result => result.status === 'rejected');
  if (rejection) throw rejection.reason;
}

export async function evolveRun(run, providers, { signal, onUpdate = async () => {} } = {}) {
  const start = Date.now();
  const { brief } = run;
  const random = rng(brief.seed);
  const cache = new Map();
  let neuralBaseline;
  let sequence = 0;
  const update = async (stage, message) => {
    signal?.throwIfAborted();
    run.stage = stage; run.metrics.elapsedMs = Date.now() - start;
    if (message) run.events.push({ time: new Date().toISOString(), message });
    await onUpdate(run);
  };
  const makeCandidate = (genome, round, parents = [], mutation = 'Initial concept') => ({
    id: `${run.id.slice(0, 8)}-${++sequence}`, round, parents, genome, ...draftCopy(genome, brief),
    asset: null, scores: null, selected: false, provisional: false, mutation,
  });
  const render = async candidates => mapLimit(candidates.filter(candidate => !candidate.asset), 2, async candidate => {
    signal?.throwIfAborted();
    candidate.asset = await providers.renderCandidate(candidate, brief, { mode: brief.mode, signal });
    signal?.throwIfAborted();
    run.metrics.rendered++;
    cache.set(fingerprint(candidate), { asset: candidate.asset, scores: candidate.scores });
  }, signal);
  const screen = candidates => {
    for (const candidate of candidates) {
      const saved = cache.get(fingerprint(candidate));
      candidate.scores = { source: 'pending', fitness: null, eligible: false };
      if (saved) {
        candidate.asset = saved.asset;
        if (saved.scores && saved.scores.source !== 'pending') candidate.scores = structuredClone(saved.scores);
        run.metrics.cacheHits++;
      }
    }
  };
  const review = async candidates => mapLimit(candidates.filter(candidate => !candidate.scores.review), 2, async candidate => {
    const result = validateScreen(await providers.screenCandidate(candidate, brief, { signal }), candidate.asset.mediaHash);
    signal?.throwIfAborted();
    candidate.scores = { source: 'vision-review', fitness: roundNumber((result.quality + result.briefAlignment) / 2),
      quality: result.quality, briefAlignment: result.briefAlignment, eligible: result.passed, review: result, neural: null,
      mediaHash: result.mediaHash, confidence: null, provenance: result.provenance };
    run.metrics.reviewed++;
    if (!result.passed) run.metrics.rejected++;
    if (result.cached) run.metrics.cacheHits++;
    cache.set(fingerprint(candidate), { asset: candidate.asset, scores: candidate.scores });
  }, signal);
  const evaluateTribe = async candidates => {
    const pending = candidates.filter(candidate => !candidate.scores.neural);
    if (!pending.length) return;
    const response = await providers.scoreTribe(pending, brief, { signal, contractHash: run.neuralConfig?.hash, baseline: neuralBaseline });
    const { results, baseline } = response || {};
    signal?.throwIfAborted();
    if (!Array.isArray(results) || new Set(results.map(result => result.id)).size !== pending.length || results.length !== pending.length) throw new Error('TRIBE worker must return one unique result for every candidate.');
    if (!baseline?.hash || !baseline.mediaHash || (neuralBaseline && baseline.hash !== neuralBaseline.hash) || (!neuralBaseline && baseline.mediaHash !== pending[0].asset.mediaHash)) throw new Error('The original neural baseline changed or is invalid.');
    neuralBaseline = baseline;
    run.neuralBaseline ??= { hash: baseline.hash, ...Object.fromEntries(Object.entries(baseline).filter(([key]) => key !== 'statsF64')), candidateId: pending[0].id, assetUrl: pending[0].asset.url,
      choice: brief.originalAsset ? 'Uploaded original; fixed across every take and generation.' : 'First shortlisted creative in generation 1; fixed across every take and generation.' };
    for (const candidate of pending) {
      const result = results.find(item => item.id === candidate.id), neural = result?.neural;
      if (!neural || neural.source !== 'tribe-percept' || !Number.isFinite(neural.engagementScore) || neural.engagementScore < 0 || neural.engagementScore > 100 || neural.baselineHash !== baseline.hash || neural.baselineMediaHash !== baseline.mediaHash || neural.contractHash !== baseline.contractHash || !neural.provenance || result.mediaHash !== candidate.asset.mediaHash) throw new Error('TRIBE returned invalid Percept scores or media identity.');
      if (run.neuralConfig && run.neuralConfig.hash !== neural.contractHash) throw new Error('The neural scoring contract changed during this run.');
      candidate.scores = { ...candidate.scores, source: 'tribe-percept', neural, metadata: result.metadata || {} };
      cache.set(fingerprint(candidate), { asset: candidate.asset, scores: candidate.scores });
      if (result.cached) run.metrics.cacheHits++;
      else run.metrics.tribeCandidates++;
    }
    run.metrics.tribeCalls += response.calls ?? Math.ceil(results.filter(result => !result.cached).length / 4);
  };
  const eligible = candidate => candidate.scores.eligible === true;
  const compareForSelection = (a, b) => compareCandidates(a, b);
  const ranked = candidates => {
    const evaluated = candidates.filter(candidate => candidate.scores.neural);
    const passed = evaluated.filter(eligible);
    // Provisional drafts only compete when there are no passing candidates.
    // Keep the original failed checks and eligibility unchanged, including in caches.
    return (passed.length ? passed : evaluated.filter(candidate => candidate.provisional)).sort(compareForSelection);
  };
  const shortlist = (candidates, count) => {
    const ordered = candidates.filter(eligible).sort((a, b) => b.scores.fitness - a.scores.fitness);
    if (!ordered.length) {
      const retained = candidates.filter(candidate => candidate.scores.review && Number.isFinite(candidate.scores.fitness))
        .sort((a, b) => reviewFailures(a) - reviewFailures(b) || b.scores.fitness - a.scores.fitness)
        .slice(0, Math.max(1, count));
      for (const candidate of retained) candidate.provisional = true;
      return retained;
    }
    // Respect K even in the last round. A run with K=1 may have fewer finalists.
    if (count === 1) return ordered.slice(0, 1);
    const chosen = ordered.slice(0, Math.max(0, count - 1));
    const remaining = ordered.filter(candidate => !chosen.includes(candidate));
    if (remaining.length) chosen.push([...remaining].sort((a, b) => {
      const diversity = candidate => Math.min(...chosen.map(other => visualDistance(candidate, other)));
      return diversity(b) - diversity(a) || b.scores.fitness - a.scores.fitness;
    })[0]);
    return chosen;
  };

  try {
    const capabilities = providers.capabilities();
    if (!capabilities.liveResearch || !(brief.mediaType === 'video' ? capabilities.liveVideos : capabilities.liveImages) || typeof providers.generateConcepts !== 'function') throw new Error('Configure OpenAI research/review and the selected image or Seedance video provider.');
    if (typeof providers.screenCandidate !== 'function') throw new Error('Live mode requires media review.');
    if (!capabilities.tribe) throw new Error('Percept scoring requires the updated TRIBE scoring endpoint. Decoder training is paused.');
    if (providers.getNeuralConfig) run.neuralConfig = providers.getNeuralConfig();
    await update('research', 'Researching the product and audience once for all generations.');
    run.research = await providers.research(brief, { mode: brief.mode, signal });
    signal?.throwIfAborted();
    let population = [];
    for (let i = 0; i < brief.population; i++) {
      const genome = Object.fromEntries(GENES.map(key => [key, pick(POOLS[key], random)]));
      genome.emotion = EMOTIONS[i % EMOTIONS.length];
      const candidate = makeCandidate(genome, 1);
      if (i === 0 && brief.originalAsset) Object.assign(candidate, { original: true, asset: brief.originalAsset, headline: `Original: ${brief.product}`, mutation: 'Uploaded original' });
      population.push(candidate);
    }
    const uploaded = population.find(candidate => candidate.original);
    if (uploaded) {
      uploaded.scores = { source: 'pending', fitness: null, eligible: false };
      await update('screening', 'Reading the original media to ground the new creative takes.');
      await review([uploaded]);
      const observed = uploaded.scores.review;
      run.research.originalMedia = { observedText: observed.observedText, transcript: observed.transcript || '', visualTags: observed.visualTags };
      uploaded.genome.hook = 'Original uploaded creative';
      uploaded.genome.visual = observed.visualTags.join(', ');
      uploaded.genome.audio = observed.transcript || 'No transcribed speech';
      cache.set(fingerprint(uploaded), { asset: uploaded.asset, scores: uploaded.scores });
    }
    for (let round = 1; round <= brief.rounds; round++) {
      await update('generating', `Generation ${round}/${brief.rounds}: ${population.length} concepts, with inherited genomes and targeted mutations.`);
      if (providers.generateConcepts) {
        const fresh = population.filter(candidate => candidate.mutation !== 'Elite retained' && !candidate.original);
        const concepts = await providers.generateConcepts(brief, run.research, { mode: brief.mode, signal, count: fresh.length, parents: round === 1 ? [] : fresh, round });
        if (!Array.isArray(concepts) || concepts.length < fresh.length) throw new Error('Concept provider returned fewer drafts than requested.');
        for (let i = 0; i < fresh.length; i++) {
          const next = cleanConcept(concepts[i], fresh[i]);
          if (round > 1) next.genome = fresh[i].genome;
          Object.assign(fresh[i], next);
        }
      }
      run.metrics.generated += population.length;
      screen(population);
      const current = { number: round, candidates: population, best: null, mean: null, selectedIds: [], evaluated: 0 };
      run.rounds.push(current);
      let chosen;
      await update('rendering', `Generation ${round}: rendering ${brief.mediaType} ads; identical drafts reuse their media.`);
      await render(population);
      await update('screening', `Generation ${round}: reviewing media, copy, supported claims and brief alignment.`);
      await review(population);
      const original = population.find(candidate => candidate.original);
      if (original && !neuralBaseline) {
        run.originalId = original.id;
        await update('scoring', 'Evaluating the uploaded original once to establish the fixed Percept baseline.');
        await evaluateTribe([original]);
      }
      chosen = shortlist(population, brief.shortlist);
      current.provisional = chosen.some(candidate => candidate.provisional);
      if (current.provisional) {
        run.metrics.provisionalRounds++;
        await update('screening', `Generation ${round}: no media passed review. Retaining ${chosen.length} provisional drafts with their failures visible.`);
      }
      current.shortlistIds = chosen.map(candidate => candidate.id);
      if (brief.scorer === 'tribe') {
        await update('scoring', `Generation ${round}: at most ${chosen.length} ${current.provisional ? 'provisional' : 'quality-approved'} takes shortlisted for neural scoring against ${run.neuralBaseline ? 'the fixed original creative' : 'the first shortlisted creative, which becomes the original baseline'}.`);
        await evaluateTribe(chosen);
      }
      const order = ranked(population);
      if (!order.length) throw new Error('No candidates with valid review data remain.');
      const parents = [order[0]];
      if (order.length > 1) parents.push([...order.slice(1)].sort((a, b) => compareForSelection(a, b) || visualDistance(b, order[0]) - visualDistance(a, order[0]))[0]);
      for (const candidate of parents) candidate.selected = true;
      current.best = selectionScore(order[0]);
      current.mean = roundNumber(order.reduce((sum, candidate) => sum + selectionScore(candidate), 0) / order.length);
      current.scoreKind = 'tribe-percept';
      current.selectedIds = parents.map(candidate => candidate.id);
      current.evaluated = order.length;
      await update('evolving', `Generation ${round}: retained the strongest candidate and selected ${parents.length} parents using the highest Percept overall scores against the shared original baseline.`);
      if (round === brief.rounds) break;
      const elite = makeCandidate({ ...order[0].genome }, round + 1, [order[0].id], 'Elite retained');
      Object.assign(elite, { headline: order[0].headline, body: order[0].body, cta: order[0].cta, original: order[0].original || false });
      cache.set(fingerprint(order[0]), { asset: order[0].asset, scores: order[0].scores });
      population = [elite];
      while (population.length < brief.population) {
        const a = pick(parents, random); const b = pick(parents, random);
        const genome = Object.fromEntries(GENES.map(key => [key, (random() < 0.5 ? a : b).genome[key]]));
        const mutatedGene = pick(GENES, random);
        genome[mutatedGene] = pick(POOLS[mutatedGene].filter(value => value !== genome[mutatedGene]), random);
        population.push(makeCandidate(genome, round + 1, [...new Set([a.id, b.id])], `Crossover + ${mutatedGene} mutation`));
      }
    }
    await update('finalizing', 'Preparing the strongest distinct final drafts across all generations.');
    const seen = new Set();
    const archive = ranked(run.rounds.flatMap(round => round.candidates));
    run.finalists = archive.filter(candidate => { const key = fingerprint(candidate); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
    run.requiresReview = run.finalists.some(candidate => candidate.provisional);
    await render(run.finalists);
    signal?.throwIfAborted();
    run.status = 'completed';
    await update('complete', `Finished ${brief.rounds} generations. ${run.requiresReview ? 'No drafts passed the media checks; the retained provisional drafts need review and revision.' : 'Finalists ranked by Percept overall score against the original creative. Scores are experimental cortical proxies, not measured emotion or ad effectiveness.'}`);
  } catch (error) {
    run.status = signal?.aborted && signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'failed';
    run.stage = run.status;
    run.error = signal?.aborted ? (signal.reason?.name === 'TimeoutError' ? 'Run exceeded the 90-minute time limit.' : 'Run cancelled.') : error.message;
    run.events.push({ time: new Date().toISOString(), message: run.error });
  } finally {
    run.metrics.elapsedMs = Date.now() - start;
    await onUpdate(run);
  }
  return run;
}
