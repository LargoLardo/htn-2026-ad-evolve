import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCandidates, createRun, evolveRun, fingerprint, scoreProxy, validateBrief } from '../lib/evolution.mjs';

const input = { product: 'Daylight', description: 'A citrus sparkling water with no added sugar.', audience: 'People looking for an afternoon ritual', goal: 'Encourage product discovery', rounds: 3, population: 8, shortlist: 3, seed: 7 };
const providers = {
  capabilities: () => ({ liveResearch: true, liveImages: true, tribe: true }),
  research: async () => ({ summary: 'Input-derived hypotheses, no web research.', insights: [], sources: [], audience: input.audience, provenance: 'demo' }),
  generateConcepts: async (brief, research, { count, parents }) => parents.length ? parents : Array.from({ length: count }, (_, index) => ({
    genome: { hook: `Concept ${index}`, visual: `Scene ${index}`, emotion: ['joy', 'trust', 'curiosity', 'desire'][index % 4], proof: 'Show one described feature', cta: 'Explore the details', palette: 'sage ivory' },
    headline: `Meet ${brief.product}, route ${index}`, body: brief.description, cta: 'Explore the details',
  })),
  renderCandidate: async candidate => ({ url: `/assets/${fingerprint(candidate)}.svg`, prompt: candidate.genome.visual, kind: 'demo-svg', mediaHash: fingerprint(candidate) }),
  screenCandidate: async candidate => ({ mediaHash: fingerprint(candidate), quality: 80, briefAlignment: 80,
    checks: { productVisible: true, copyReadable: true, copyAccurate: true, claimsSupported: true, noMajorDefects: true },
    observedText: candidate.headline, reasons: [], visualTags: [candidate.genome.visual], provenance: 'TEST image review' }),
  scoreTribe: async (candidates, brief) => candidates.map(candidate => ({ id: candidate.id,
    neural: { source: 'tribe-pattern-experimental', target: brief.neuralTarget, targetPercentile: 70, usableForSelection: true,
      referenceHash: 'test-ref', referenceCount: 60, confidence: null, provenance: 'TEST pattern comparison', patterns: {} },
    mediaHash: fingerprint(candidate), metadata: { protocol: 'test-fixture', uncertainty: 'not-estimated' } })),
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

test('TRIBE is gated, respects K, reuses elites and only selects reviewed neural candidates', async () => {
  const rejected = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), { ...providers, capabilities: () => ({ liveResearch: true, liveImages: true, tribe: false }) });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /feature endpoint/);
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', shortlist: 3 })), providers);
  assert.equal(result.status, 'completed');
  assert.ok(result.metrics.tribeCalls <= 3);
  assert.ok(result.metrics.tribeCandidates <= 9);
  assert.equal(result.finalists.length, 3);
  assert.ok(result.finalists.every(candidate => candidate.scores.source === 'tribe-pattern-experimental'));
  assert.ok(result.finalists.every(candidate => candidate.scores.mediaHash === fingerprint(candidate)));
  assert.ok(result.finalists.every(candidate => candidate.scores.metadata.protocol === 'test-fixture' && candidate.scores.confidence === null));
  assert.ok(result.rounds.flatMap(round => round.candidates).some(candidate => candidate.scores.source === 'vision-review'));
});

test('malformed worker scores fail closed and cancellation stops before rendering', async () => {
  const invalid = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), { ...providers, scoreTribe: async candidates => candidates.map(candidate => ({ id: candidate.id, emotions: { joy: 900 }, confidence: 0.9 })) });
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.error, /invalid experimental/);
  const controller = new AbortController();
  const cancelled = await evolveRun(createRun(validateBrief(input)), { ...providers, research: async () => { controller.abort(); return {}; } }, { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.metrics.rendered, 0);
});

test('failed image checks block both parents and finalists before neural inference', async () => {
  const rejected = new Set();
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', rounds: 2 })), {
    ...providers,
    screenCandidate: async candidate => {
      const result = await providers.screenCandidate(candidate);
      if (candidate.headline.includes('route 0')) { result.checks.copyAccurate = false; rejected.add(candidate.id); }
      return result;
    },
    scoreTribe: async (candidates, brief) => {
      assert.ok(candidates.every(candidate => !rejected.has(candidate.id)));
      assert.ok(candidates.every(candidate => candidate.asset && candidate.scores.review));
      return providers.scoreTribe(candidates, brief);
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(rejected.size > 0);
  assert.ok(result.rounds.flatMap(round => round.selectedIds).every(id => !rejected.has(id)));
  assert.ok(result.finalists.every(candidate => !rejected.has(candidate.id)));
  assert.ok(result.metrics.rejected > 0);
});

test('neural percentile cannot overcome a worse visual band and invalid features do not win', () => {
  const candidate = (fitness, percentile, usableForSelection = true) => ({ scores: { source: 'tribe-pattern-experimental', fitness, neural: { targetPercentile: percentile, usableForSelection } } });
  assert.ok(compareCandidates(candidate(90, 0), candidate(84.9, 100)) < 0);
  assert.ok(compareCandidates(candidate(81, 95), candidate(84, 10)) < 0);
  assert.ok(compareCandidates(candidate(81, 100, false), candidate(84, 60)) > 0);
});

test('K=1 never expands for finalists; live image-only mode needs no TRIBE', async () => {
  const single = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', shortlist: 1, rounds: 1 })), providers);
  assert.equal(single.status, 'completed', single.error);
  assert.equal(single.metrics.tribeCandidates, 1);
  assert.equal(single.finalists.length, 1);
  const visual = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'proxy', rounds: 1 })), {
    ...providers, scoreTribe: () => { throw new Error('Unexpected neural call'); },
  });
  assert.equal(visual.status, 'completed', visual.error);
  assert.equal(visual.metrics.reviewed, 8);
  assert.equal(visual.metrics.tribeCandidates, 0);
  assert.ok(visual.finalists.every(candidate => candidate.scores.source === 'vision-review' && !('joy' in candidate.scores)));
});

test('all failed reviews retain a nonempty provisional shortlist without changing failed checks', async () => {
  for (const scorer of ['proxy', 'tribe']) for (const shortlist of [1, 3]) {
    const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer, shortlist })), {
      ...providers, screenCandidate: async candidate => {
        const review = await providers.screenCandidate(candidate);
        return { ...review, quality: 0, briefAlignment: 0, checks: Object.fromEntries(Object.keys(review.checks).map(key => [key, false])) };
      },
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.rounds.length, input.rounds);
    assert.equal(result.requiresReview, true);
    assert.equal(result.metrics.provisionalRounds, input.rounds);
    assert.ok(result.finalists.length > 0);
    assert.ok(result.finalists.every(candidate => candidate.provisional && !candidate.scores.eligible && !candidate.scores.review.passed));
    assert.ok(result.rounds.every(round => round.shortlistIds.length > 0 && round.shortlistIds.length <= shortlist && round.selectedIds.length > 0));
    assert.ok(result.metrics.tribeCandidates <= input.rounds * shortlist);
    if (scorer === 'tribe') assert.ok(result.finalists.every(candidate => candidate.scores.neural));
    assert.equal(result.rounds.flatMap(round => round.candidates).length, input.rounds * input.population);
  }
});

test('one passing candidate prevents fallback even if failed drafts have higher scores', async () => {
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', rounds: 1 })), {
    ...providers, screenCandidate: async candidate => {
      const review = await providers.screenCandidate(candidate), passes = candidate.headline.includes('route 0');
      return { ...review, quality: passes ? 60 : 100, briefAlignment: passes ? 60 : 100, checks: { ...review.checks, copyAccurate: passes } };
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.metrics.provisionalRounds, 0);
  assert.equal(result.rounds[0].shortlistIds.length, 1);
  assert.equal(result.requiresReview, false);
  assert.equal(result.finalists.length, 1);
  assert.ok(result.finalists.every(candidate => candidate.scores.eligible && !candidate.provisional));
});

test('later passing drafts replace earlier provisional winners without rewriting cached reviews', async () => {
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), {
    ...providers, screenCandidate: async candidate => {
      const review = await providers.screenCandidate(candidate), passes = candidate.round > 1;
      return { ...review, quality: passes ? 60 : 95, briefAlignment: passes ? 60 : 95, checks: { ...review.checks, claimsSupported: passes } };
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.metrics.provisionalRounds, 1);
  assert.equal(result.requiresReview, false);
  assert.ok(result.finalists.every(candidate => candidate.scores.eligible && !candidate.provisional && candidate.round > 1));
  assert.ok(result.rounds[0].candidates.every(candidate => !candidate.scores.review.passed));
  const cachedElite = result.rounds[1].candidates.find(candidate => candidate.mutation === 'Elite retained');
  assert.equal(cachedElite.scores.eligible, false);
  assert.equal(cachedElite.provisional, false);
  assert.ok(!result.rounds[1].selectedIds.includes(cachedElite.id));
});

test('shortlist combines strongest image reviews with observed visual diversity', async () => {
  let selected = [];
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', rounds: 1 })), {
    ...providers,
    screenCandidate: async candidate => {
      const index = Number(candidate.headline.match(/route (\d+)/)[1]);
      return { ...(await providers.screenCandidate(candidate)), quality: 95 - index, briefAlignment: 95 - index,
        visualTags: index === 7 ? ['person', 'outdoors'] : ['product', 'closeup'] };
    },
    scoreTribe: async (candidates, brief) => { selected = candidates.map(c => c.headline); return providers.scoreTribe(candidates, brief); },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(selected.map(headline => Number(headline.match(/route (\d+)/)[1])), [0, 1, 7]);
});

test('a changed reference is rejected before research or mixing scores', async () => {
  const early = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), {
    ...providers, getNeuralReference: () => { throw new Error('Reference checksum failed'); },
    research: () => { throw new Error('Must not research'); },
  });
  assert.equal(early.error, 'Reference checksum failed');
  assert.equal(early.metrics.rendered, 0);
  const mixed = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), {
    ...providers, getNeuralReference: () => ({ hash: 'different-reference' }),
  });
  assert.equal(mixed.status, 'failed');
  assert.match(mixed.error, /reference changed/);
});
