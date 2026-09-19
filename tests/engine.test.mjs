import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCandidates, createRun, evolveRun, fingerprint, validateBrief } from '../lib/evolution.mjs';

const input = { product: 'Daylight', description: 'A citrus sparkling water with no added sugar.', audience: 'People looking for an afternoon ritual', goal: 'Encourage product discovery', rounds: 3, population: 8, shortlist: 3, seed: 7 };
const providers = {
  capabilities: () => ({ liveResearch: true, liveImages: true, liveVideos: true, tribe: true }),
  research: async () => ({ summary: 'Input-derived hypotheses, no web research.', insights: [], sources: [], audience: input.audience, provenance: 'demo' }),
  generateConcepts: async (brief, research, { count, parents }) => parents.length ? parents : Array.from({ length: count }, (_, index) => ({
    genome: { hook: `Concept ${index}`, visual: `Scene ${index}`, emotion: ['joy', 'trust', 'curiosity', 'desire'][index % 4], proof: 'Show one described feature', cta: 'Explore the details', palette: 'sage ivory', motion: 'reveal', audio: 'quiet voiceover' },
    headline: `Meet ${brief.product}, route ${index}`, body: brief.description, cta: 'Explore the details',
  })),
  renderCandidate: async candidate => ({ url: `/assets/${fingerprint(candidate)}.svg`, prompt: candidate.genome.visual, kind: 'demo-svg', mediaHash: fingerprint(candidate) }),
  screenCandidate: async candidate => ({ mediaHash: fingerprint(candidate), quality: 80, briefAlignment: 80,
    checks: { productVisible: true, copyReadable: true, copyAccurate: true, claimsSupported: true, noMajorDefects: true },
    observedText: candidate.headline, reasons: [], visualTags: [candidate.genome.visual], provenance: 'TEST image review' }),
  getNeuralConfig: () => ({ hash: 'test-atlas', version: 'percept-glasser-test' }),
  scoreTribe: async (candidates, brief, { baseline } = {}) => {
    baseline ??= { hash: 'test-baseline', contractHash: 'test-atlas', mediaHash: candidates[0].asset.mediaHash };
    return { baseline, results: candidates.map(candidate => ({ id: candidate.id,
      neural: { source: 'tribe-percept', engagementScore: 70,
        baselineHash: baseline.hash, baselineMediaHash: baseline.mediaHash, contractHash: baseline.contractHash,
        confidence: null, provenance: 'TEST media normalization', networks: {} },
      mediaHash: fingerprint(candidate), metadata: { protocol: 'test-fixture', uncertainty: 'not-estimated' } })) };
  },
};

test('seeded evolution preserves elites, mutates descendants, reuses assets and uses Percept scores', async () => {
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
    assert.equal(candidate.scores.source, 'tribe-percept');
    assert.equal(candidate.scores.confidence, null);
  }
});

test('invalid media, budgets and removed heuristic modes are rejected before work', () => {
  assert.throws(() => validateBrief({ ...input, rounds: 7 }), /rounds/);
  assert.throws(() => validateBrief({ ...input, population: 100 }), /population/);
  assert.throws(() => validateBrief({ ...input, mediaType: 'audio' }), /image or video/);
  assert.throws(() => validateBrief({ ...input, videoDuration: 100 }), /videoDuration/);
  assert.throws(() => validateBrief({ ...input, mode: 'demo' }), /removed/);
  assert.throws(() => validateBrief({ ...input, scorer: 'proxy' }), /removed/);
  assert.throws(() => validateBrief({ ...input, originalMediaId: '../file' }), /media ID/);
});

test('TRIBE is gated, respects K, reuses elites and only selects reviewed neural candidates', async () => {
  const rejected = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), { ...providers, capabilities: () => ({ liveResearch: true, liveImages: true, liveVideos: true, tribe: false }) });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /scoring endpoint/);
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', shortlist: 3 })), providers);
  assert.equal(result.status, 'completed');
  assert.ok(result.metrics.tribeCalls <= 3);
  assert.ok(result.metrics.tribeCandidates <= 9);
  assert.equal(result.finalists.length, 3);
  assert.ok(result.finalists.every(candidate => candidate.scores.source === 'tribe-percept'));
  assert.ok(result.finalists.every(candidate => candidate.scores.mediaHash === fingerprint(candidate)));
  assert.ok(result.finalists.every(candidate => candidate.scores.metadata.protocol === 'test-fixture' && candidate.scores.confidence === null));
  assert.ok(result.rounds.flatMap(round => round.candidates).some(candidate => candidate.scores.source === 'vision-review'));
});

test('malformed worker scores fail closed and cancellation stops before rendering', async () => {
  const invalid = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), { ...providers, scoreTribe: async candidates => candidates.map(candidate => ({ id: candidate.id, emotions: { joy: 900 }, confidence: 0.9 })) });
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.error, /unique result/);
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
    scoreTribe: async (candidates, brief, options) => {
      assert.ok(candidates.every(candidate => !rejected.has(candidate.id)));
      assert.ok(candidates.every(candidate => candidate.asset && candidate.scores.review));
      return providers.scoreTribe(candidates, brief, options);
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(rejected.size > 0);
  assert.ok(result.rounds.flatMap(round => round.selectedIds).every(id => !rejected.has(id)));
  assert.ok(result.finalists.every(candidate => !rejected.has(candidate.id)));
  assert.ok(result.metrics.rejected > 0);
});

test('highest neural score wins across visual bands; visual quality only breaks ties', () => {
  const candidate = (fitness, engagementScore) => ({ scores: { source: 'tribe-percept', fitness, neural: { source: 'tribe-percept', engagementScore, usableForSelection: true } } });
  assert.ok(compareCandidates(candidate(90, 20), candidate(65, 80)) > 0);
  assert.ok(compareCandidates(candidate(81, 95), candidate(84, 10)) < 0);
  assert.ok(compareCandidates(candidate(81, 60), candidate(84, 60)) > 0);
});

test('one original baseline persists across generations and neural winners drive chart, parents and finalists', async () => {
  let calls = 0, original;
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', rounds: 2 })), {
    ...providers,
    screenCandidate: async candidate => {
      const review = await providers.screenCandidate(candidate);
      const first = candidate.headline.includes('route 0');
      return { ...review, quality: first ? 95 : 65, briefAlignment: first ? 95 : 65 };
    },
    scoreTribe: async (candidates, brief, options) => {
      if (calls) assert.equal(options.baseline, original);
      else assert.equal(options.baseline, undefined);
      const response = await providers.scoreTribe(candidates, brief, options);
      original ??= response.baseline;
      for (const item of response.results) item.neural.engagementScore = calls ? 60 : item.id === candidates[0].id ? 20 : 80;
      calls++;
      return response;
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(calls, 2);
  assert.equal(result.neuralBaseline.mediaHash, original.mediaHash);
  assert.equal(result.neuralBaseline.candidateId, result.rounds[0].shortlistIds[0]);
  assert.ok(result.rounds.every(round => round.best === 80 && round.scoreKind === 'tribe-percept'));
  assert.equal(result.finalists[0].scores.fitness, 65);
  assert.equal(result.finalists[0].scores.neural.engagementScore, 80);
  assert.notEqual(result.rounds[0].selectedIds[0], result.neuralBaseline.candidateId);
});

test('changing the original baseline midway through evolution fails explicitly', async () => {
  let calls = 0;
  const result = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', rounds: 2 })), {
    ...providers, scoreTribe: async (candidates, brief, options) => {
      const response = await providers.scoreTribe(candidates, brief, options);
      if (calls++) response.baseline = { ...response.baseline, hash: 'another-original' };
      return response;
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /original neural baseline changed/);
});

test('K=1 never expands for finalists', async () => {
  const single = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe', shortlist: 1, rounds: 1 })), providers);
  assert.equal(single.status, 'completed', single.error);
  assert.equal(single.metrics.tribeCandidates, 1);
  assert.equal(single.finalists.length, 1);

});

test('all failed reviews retain a nonempty provisional shortlist without changing failed checks', async () => {
  for (const scorer of ['tribe']) for (const shortlist of [1, 3]) {
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
    scoreTribe: async (candidates, brief, options) => { selected = candidates.map(c => c.headline); return providers.scoreTribe(candidates, brief, options); },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(selected.map(headline => Number(headline.match(/route (\d+)/)[1])), [0, 1, 7]);
});

test('a changed reference is rejected before research or mixing scores', async () => {
  const early = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), {
    ...providers, getNeuralConfig: () => { throw new Error('Reference checksum failed'); },
    research: () => { throw new Error('Must not research'); },
  });
  assert.equal(early.error, 'Reference checksum failed');
  assert.equal(early.metrics.rendered, 0);
  const mixed = await evolveRun(createRun(validateBrief({ ...input, mode: 'live', scorer: 'tribe' })), {
    ...providers, getNeuralConfig: () => ({ hash: 'different-reference' }),
  });
  assert.equal(mixed.status, 'failed');
  assert.match(mixed.error, /scoring contract changed/);
});

test('single-gene mutation from main is preserved alongside the eight-gene pipeline', async () => {
  const genome = { hook: 'same hook', visual: 'same scene', emotion: 'joy', proof: 'same proof', cta: 'same action', palette: 'same palette', motion: 'same motion', audio: 'same audio' };
  const result = await evolveRun(createRun(validateBrief({ ...input, rounds: 2 })), {
    ...providers,
    generateConcepts: async (brief, findings, options) => options.parents.length ? options.parents : Array.from({ length: options.count }, (_, i) => ({ genome: { ...genome }, headline: `Route ${i}`, body: brief.description, cta: 'Discover' })),
  });
  assert.equal(result.status, 'completed', result.error);
  for (const child of result.rounds[1].candidates.filter(c => c.mutation !== 'Elite retained')) {
    assert.equal(Object.keys(genome).filter(key => child.genome[key] !== genome[key]).length, 1);
    assert.equal(Object.keys(child.genome).length, 8);
  }
});
