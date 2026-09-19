import { createHash, randomUUID } from 'node:crypto';

export const EMOTIONS = ['joy', 'trust', 'curiosity', 'desire'];
export const LIMITS = { rounds: 6, population: 16, activeRuns: 2, maxBodyBytes: 24_000 };
const GENES = ['hook', 'visual', 'emotion', 'proof', 'cta', 'palette'];
const POOLS = {
  hook: ['A small everyday transformation', 'A surprising question', 'A moment of shared delight', 'A clear practical benefit', 'A fresh perspective'],
  visual: ['Product in a quiet daily ritual', 'Bold editorial product close-up', 'An illustrated before-and-after moment', 'Human-centered lifestyle scene', 'Minimal product silhouette'],
  emotion: ['joy', 'trust', 'curiosity', 'desire'],
  proof: ['Explain the product plainly', 'Show how it fits a daily routine', 'Demonstrate one described feature', 'Invite the audience to explore details'],
  cta: ['Explore the details', 'Meet your next favorite', 'Find your everyday upgrade', 'See how it works'],
  palette: ['coral cream', 'sage ivory', 'electric lavender', 'midnight amber', 'ocean blue'],
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
  const mode = input.mode ?? 'demo';
  const scorer = input.scorer ?? 'proxy';
  if (!['demo', 'live'].includes(mode)) throw new Error('mode must be demo or live.');
  if (!['proxy', 'tribe'].includes(scorer)) throw new Error('scorer must be proxy or tribe.');
  if (scorer === 'tribe' && mode !== 'live') throw new Error('TRIBE scoring requires live-generated PNG ads. Demo storyboards use heuristic scoring.');
  const weights = Object.fromEntries(EMOTIONS.map(key => [key, input.weights?.[key] ?? 25]));
  if (Object.values(weights).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) || !Object.values(weights).some(Boolean)) throw new Error('Emotion weights must be 0–100, with at least one positive weight.');
  const population = integer('population', 8, 4, LIMITS.population);
  return {
    product: string('product', 1, 100), description: string('description', 3, 4_000),
    audience: string('audience', 0, 800, 'People interested in this product'),
    goal: string('goal', 1, 800, 'Introduce the product and encourage discovery'),
    weights, rounds: integer('rounds', 3, 1, LIMITS.rounds), population,
    shortlist: integer('shortlist', 3, 1, population), seed: integer('seed', 42, 0, 2_147_483_647), mode, scorer,
  };
}

export function createRun(brief) {
  return {
    id: randomUUID(), status: 'running', stage: 'queued', brief, research: null, rounds: [], finalists: [], events: [],
    metrics: { generated: 0, cacheHits: 0, tribeCalls: 0, tribeCandidates: 0, rendered: 0, elapsedMs: 0 },
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
const fitness = (emotions, weights) => roundNumber(EMOTIONS.reduce((sum, key) => sum + emotions[key] * weights[key], 0) / Object.values(weights).reduce((a, b) => a + b, 0));

export function scoreProxy(candidate, brief) {
  const text = `${Object.values(candidate.genome).join(' ')} ${candidate.headline} ${candidate.body}`.toLowerCase();
  // ponytail: transparent design priors screen concepts; replace with held-out human-calibrated predictions before interpreting emotion.
  const signals = {
    joy: /joy|delight|shared|favorite|coral|play|smile/g,
    trust: /trust|practical|plain|feature|routine|sage|quiet|works|detail/g,
    curiosity: /curiosity|question|surpris|fresh|perspective|explor|lavender|discover/g,
    desire: /desire|transform|upgrade|close-up|amber|favorite|ritual/g,
  };
  const emotions = Object.fromEntries(EMOTIONS.map(key => {
    const matches = (text.match(signals[key]) || []).length;
    return [key, Math.min(90, 38 + matches * 5 + (candidate.genome.emotion.toLowerCase().includes(key) ? 15 : 0))];
  }));
  return { ...emotions, fitness: fitness(emotions, brief.weights), confidence: null, source: 'heuristic', provenance: 'Design priors only; not measured emotion or conversion prediction.' };
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
  let sequence = 0;
  const update = async (stage, message) => {
    signal?.throwIfAborted();
    run.stage = stage; run.metrics.elapsedMs = Date.now() - start;
    if (message) run.events.push({ time: new Date().toISOString(), message });
    await onUpdate(run);
  };
  const makeCandidate = (genome, round, parents = [], mutation = 'Initial concept') => ({
    id: `${run.id.slice(0, 8)}-${++sequence}`, round, parents, genome, ...draftCopy(genome, brief),
    asset: null, scores: null, selected: false, mutation,
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
      candidate.scores = scoreProxy(candidate, brief);
      candidate.scores.proxyFitness = candidate.scores.fitness;
      if (saved) {
        candidate.asset = saved.asset;
        if (saved.scores?.source === 'tribe-calibrated') candidate.scores = structuredClone(saved.scores);
        run.metrics.cacheHits++;
      }
    }
  };
  const evaluateTribe = async candidates => {
    const pending = candidates.filter(candidate => candidate.scores.source !== 'tribe-calibrated');
    if (!pending.length) return;
    const results = await providers.scoreTribe(pending, brief, { signal });
    signal?.throwIfAborted();
    if (!Array.isArray(results) || new Set(results.map(result => result.id)).size !== pending.length || results.length !== pending.length) throw new Error('TRIBE worker must return one unique result for every candidate.');
    for (const candidate of pending) {
      const result = results.find(item => item.id === candidate.id);
      if (!result || EMOTIONS.some(key => !Number.isFinite(result.emotions?.[key]) || result.emotions[key] < 0 || result.emotions[key] > 100) || (result.confidence !== null && (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1)) || !result.provenance) throw new Error('TRIBE worker returned invalid calibrated emotion scores or provenance.');
      candidate.scores = { ...result.emotions, fitness: fitness(result.emotions, brief.weights), proxyFitness: candidate.scores.proxyFitness, confidence: result.confidence, source: 'tribe-calibrated', provenance: result.provenance, mediaHash: result.mediaHash ?? candidate.asset?.mediaHash, metadata: result.metadata ?? {} };
      cache.set(fingerprint(candidate), { asset: candidate.asset, scores: candidate.scores });
    }
    run.metrics.tribeCalls++; run.metrics.tribeCandidates += pending.length;
  };
  const ranked = candidates => candidates.filter(candidate => brief.scorer !== 'tribe' || candidate.scores.source === 'tribe-calibrated').sort((a, b) => b.scores.fitness - a.scores.fitness);
  const shortlist = (candidates, count) => {
    const ordered = [...candidates].sort((a, b) => b.scores.proxyFitness - a.scores.proxyFitness);
    const chosen = ordered.slice(0, Math.max(0, count - 1));
    const remaining = ordered.filter(candidate => !chosen.includes(candidate));
    // One slot explores genome distance. With K=1, alternate exploitation and exploration by round.
    if (count === 1 && candidates[0].round % 2 === 1) chosen.push(ordered[0]);
    else if (remaining.length) chosen.push([...remaining].sort((a, b) => {
      const diversity = candidate => chosen.length ? Math.min(...chosen.map(other => distance(candidate, other))) : distance(candidate, ordered[0]);
      return diversity(b) - diversity(a) || b.scores.proxyFitness - a.scores.proxyFitness;
    })[0]);
    return chosen;
  };

  try {
    const capabilities = providers.capabilities();
    if (brief.mode === 'live' && (!capabilities.liveResearch || !capabilities.liveImages || typeof providers.generateConcepts !== 'function')) throw new Error('Live mode requires configured research, concept, and image providers.');
    if (brief.scorer === 'tribe' && !capabilities.tribe) throw new Error('TRIBE scoring requires an external worker with a human-calibrated emotion readout. Configure the worker or use the clearly labeled heuristic demo.');
    await update('research', brief.mode === 'demo' ? 'Building a product hypothesis brief from your input. Demo research does not browse the web.' : 'Researching the product and audience once for all generations.');
    run.research = await providers.research(brief, { mode: brief.mode, signal });
    signal?.throwIfAborted();
    let population = [];
    for (let i = 0; i < brief.population; i++) {
      const genome = Object.fromEntries(GENES.map(key => [key, pick(POOLS[key], random)]));
      genome.emotion = EMOTIONS[i % EMOTIONS.length];
      population.push(makeCandidate(genome, 1));
    }
    for (let round = 1; round <= brief.rounds; round++) {
      await update('generating', `Generation ${round}/${brief.rounds}: ${population.length} concepts, with inherited genomes and targeted mutations.`);
      if (brief.mode === 'live' && providers.generateConcepts) {
        const fresh = population.filter(candidate => candidate.mutation !== 'Elite retained');
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
      await update('screening', `Generation ${round}: screening with transparent design priors; these are not human response measurements.`);
      const chosen = shortlist(population, Math.min(population.length, round === brief.rounds ? Math.max(3, brief.shortlist) : brief.shortlist));
      await update('rendering', `Generation ${round}: rendering ${chosen.filter(candidate => !candidate.asset).length} shortlisted concepts; cached assets are reused.`);
      await render(chosen);
      if (brief.scorer === 'tribe') {
        await update('scoring', `Generation ${round}: sending one batch of ${chosen.filter(candidate => candidate.scores.source !== 'tribe-calibrated').length} new stimuli to the calibrated TRIBE worker.`);
        await evaluateTribe(chosen);
      }
      const order = ranked(population);
      if (!order.length) throw new Error('No eligible scored candidates remain.');
      const parents = [order[0]];
      if (order.length > 1) parents.push([...order.slice(1)].sort((a, b) => (b.scores.fitness + distance(b, order[0]) * 12) - (a.scores.fitness + distance(a, order[0]) * 12))[0]);
      for (const candidate of parents) candidate.selected = true;
      current.best = order[0].scores.fitness;
      current.mean = roundNumber(order.reduce((sum, candidate) => sum + candidate.scores.fitness, 0) / order.length);
      current.selectedIds = parents.map(candidate => candidate.id);
      current.evaluated = order.length;
      await update('evolving', `Generation ${round}: retained the strongest candidate and selected ${parents.length} diverse parents using ${brief.scorer === 'tribe' ? 'calibrated worker' : 'heuristic'} fitness.`);
      if (round === brief.rounds) break;
      const elite = makeCandidate({ ...order[0].genome }, round + 1, [order[0].id], 'Elite retained');
      Object.assign(elite, { headline: order[0].headline, body: order[0].body, cta: order[0].cta });
      cache.set(fingerprint(order[0]), { asset: order[0].asset, scores: order[0].scores });
      population = [elite];
      while (population.length < brief.population) {
        const a = pick(parents, random); const b = pick(parents, random);
        const genome = Object.fromEntries(GENES.map(key => [key, (random() < 0.5 ? a : b).genome[key]]));
        const mutations = [pick(GENES, random)];
        if (random() < 0.35) mutations.push(pick(GENES.filter(key => !mutations.includes(key)), random));
        for (const key of mutations) genome[key] = pick(POOLS[key].filter(value => value !== genome[key]), random);
        population.push(makeCandidate(genome, round + 1, [...new Set([a.id, b.id])], `Crossover + ${mutations.join(', ')} mutation`));
      }
    }
    await update('finalizing', 'Preparing the strongest distinct final drafts across all generations.');
    const seen = new Set();
    const archive = ranked(run.rounds.flatMap(round => round.candidates));
    run.finalists = archive.filter(candidate => { const key = fingerprint(candidate); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
    await render(run.finalists);
    signal?.throwIfAborted();
    run.status = 'completed';
    await update('complete', `Finished ${brief.rounds} generations. ${brief.scorer === 'proxy' ? 'Final rankings are heuristic design scores, not measured emotional responses.' : 'Final rankings use the external worker’s calibrated emotion predictions; validate them with human studies.'}`);
  } catch (error) {
    run.status = signal?.aborted && signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'failed';
    run.stage = run.status;
    run.error = signal?.aborted ? (signal.reason?.name === 'TimeoutError' ? 'Run exceeded the 20-minute time limit.' : 'Run cancelled.') : error.message;
    run.events.push({ time: new Date().toISOString(), message: run.error });
  } finally {
    run.metrics.elapsedMs = Date.now() - start;
    await onUpdate(run);
  }
  return run;
}
