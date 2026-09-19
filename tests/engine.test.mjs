import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, evolveRun, fingerprint, scoreProxy, validateBrief } from '../lib/evolution.mjs';

const input = { product: 'Daylight', description: 'A citrus sparkling water with no added sugar.', audience: 'People looking for an afternoon ritual', goal: 'Encourage product discovery', rounds: 3, population: 8, shortlist: 3, seed: 7 };
const providers = {
  capabilities: () => ({ liveResearch: true, liveImages: true, tribe: true }),
  research: async () => ({ summary: 'Input-derived hypotheses, no web research.', insights: [], sources: [], audience: input.audience, provenance: 'demo' }),
  generateConcepts: async (brief, research, { count, parents }) => parents.length ? parents : Array.from({ length: count }, (_, index) => ({
    genome: { hook: `Concept ${index}`, visual: `Scene ${index}`, emotion: ['joy', 'trust', 'curiosity', 'desire'][index % 4], proof: 'Show one described feature', cta: 'Explore the details', palette: 'sage ivory' },
    headline: `Meet ${brief.product}, route ${index}`, body: brief.description, cta: 'Explore the details',
  })),
  renderCandidate: async candidate => ({ url: `/assets/${fingerprint(candidate)}.svg`, prompt: candidate.genome.visual, kind: 'demo-svg' }),
  scoreTribe: async candidates => candidates.map(candidate => ({ id: candidate.id, emotions: { joy: 70, trust: 60, curiosity: 40, desire: 80 }, confidence: null, provenance: 'TEST STUB: not real TRIBE inference', mediaHash: fingerprint(candidate), metadata: { protocol: 'test-fixture', uncertainty: 'not-estimated' } })),
};

test('seeded evolution preserves elites, mutates descendants, reuses assets, and labels proxy honestly', async () => {
  const first = await evolveRun(createRun(validateBrief(input)), providers);
  const second = await evolveRun(createRun(validateBrief(input)), providers);
  assert.equal(first.status, 'completed');
  assert.equal(first.rounds.length, 3);
  assert.equal(first.finalists.length, 3);
  assert.deepEqual(first.rounds.map(round => round.candidates.map(fingerprint)), second.rounds.map(round => round.candidates.map(fingerprint)));
  assert.ok(first.metrics.cacheHits >= 2);
  assert.ok(first.metrics.rendered < first.metrics.generated);
  assert.ok(first.rounds.every((round, index) => !index || round.best >= first.rounds[index - 1].best));
  const candidates = new Map(first.rounds.flatMap(round => round.candidates).map(candidate => [candidate.id, candidate]));
  for (const candidate of first.rounds.slice(1).flatMap(round => round.candidates)) {
    assert.ok(candidate.parents.length);
    assert.ok(candidate.parents.every(id => candidates.get(id).round === candidate.round - 1));
    if (candidate.mutation !== 'Elite retained') assert.ok(candidate.parents.some(id => fingerprint(candidates.get(id)) !== fingerprint(candidate)));
  }
  for (const candidate of first.finalists) {
    assert.ok(candidate.asset.url);
    assert.equal(candidate.scores.source, 'heuristic');
    assert.equal(candidate.scores.confidence, null);
  }
});

test('weights change fitness, invalid budgets/weights are rejected before work', () => {
  assert.throws(() => validateBrief({ ...input, rounds: 7 }), /rounds/);
  assert.throws(() => validateBrief({ ...input, population: 100 }), /population/);
  assert.throws(() => validateBrief({ ...input, weights: { joy: 0, trust: 0, curiosity: 0, desire: 0 } }), /weights/);
  assert.throws(() => validateBrief({ ...input, weights: { joy: '80' } }), /weights/);
  const candidate = { genome: { hook: 'surprising question', visual: 'fresh perspective', emotion: 'curiosity', proof: 'plain', cta: 'explore', palette: 'lavender' }, headline: 'A discovery', body: 'Fresh perspective' };
  const curiosity = scoreProxy(candidate, validateBrief({ ...input, weights: { joy: 0, trust: 0, curiosity: 100, desire: 0 } }));
  const trust = scoreProxy(candidate, validateBrief({ ...input, weights: { joy: 0, trust: 100, curiosity: 0, desire: 0 } }));
  assert.ok(curiosity.fitness > trust.fitness);
});

test('TRIBE is gated, batched, and final rankings never mix proxy with worker scores', async () => {
  const rejected = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), { ...providers, capabilities: () => ({ liveResearch: true, liveImages: true, tribe: false }) });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /calibrated/);
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', shortlist: 1 })), providers);
  assert.equal(result.status, 'completed');
  assert.ok(result.metrics.tribeCalls <= 3);
  assert.ok(result.metrics.tribeCandidates <= 5);
  assert.equal(result.finalists.length, 3);
  assert.ok(result.finalists.every(candidate => candidate.scores.source === 'tribe-calibrated'));
  assert.ok(result.finalists.every(candidate => candidate.scores.mediaHash === fingerprint(candidate)));
  assert.ok(result.finalists.every(candidate => candidate.scores.metadata.protocol === 'test-fixture' && candidate.scores.confidence === null));
  assert.ok(result.rounds.flatMap(round => round.candidates).some(candidate => candidate.scores.source === 'heuristic'));
});

test('malformed worker scores fail closed and cancellation stops before rendering', async () => {
  const invalid = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), { ...providers, scoreTribe: async candidates => candidates.map(candidate => ({ id: candidate.id, emotions: { joy: 900 }, confidence: 0.9 })) });
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.error, /invalid calibrated/);
  const controller = new AbortController();
  const cancelled = await evolveRun(createRun(validateBrief(input)), { ...providers, research: async () => { controller.abort(); return {}; } }, { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.metrics.rendered, 0);
});
