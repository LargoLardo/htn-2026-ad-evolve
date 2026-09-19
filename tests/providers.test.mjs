import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../lib/neural-scorer.mjs';
import { featureFixture, referenceFixture } from './neural-fixture.mjs';
import { capabilities, generateConcepts, renderCandidate, research, scoreTribe, screenCandidate } from '../lib/providers.mjs';

const brief = { product: 'Example', description: 'A reusable notebook', audience: 'Designers', goal: 'Discovery', mode: 'live', population: 1 };
const draft = { id: 'candidate-1', round: 1, genome: { hook: 'question', visual: 'A notebook on a desk', emotion: 'curiosity', proof: 'Show the notebook', cta: 'Discover', palette: 'sage' }, headline: 'Your next idea', body: 'Make space for a fresh idea.', cta: 'Discover Example' };
const response = (parsed, extra = []) => ({ status: 'completed', output: [...extra, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(parsed), annotations: [] }] }] });
function config(t, values = {}) {
  const old = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: 'test-secret-do-not-display', TRIBE_FEATURES_URL: 'http://127.0.0.1:8091/features', ...values });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
}

test('demo stays offline and escapes local storyboard content', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network call'); });
  const findings = await research(brief, { mode: 'demo' });
  assert.equal(findings.sources.length, 0);
  assert.ok(findings.insights.every(insight => insight.kind === 'hypothesis'));
  const art = await renderCandidate({ ...draft, headline: '<script>alert(1)</script>' }, brief, { mode: 'demo' });
  const svg = await readFile(`data${art.url}`, 'utf8');
  assert.equal(art.kind, 'local-storyboard');
  assert.ok(svg.includes('NOT AI GENERATED'));
  assert.ok(!svg.includes('<script>'));
  assert.equal((await renderCandidate({ ...draft, headline: '<script>alert(1)</script>' }, brief, { mode: 'demo' })).mediaHash, art.mediaHash);
});

test('live research requires search and ties evidence to actual returned sources', async t => {
  config(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.tools[0].type, 'web_search');
    assert.equal(body.store, false);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(response({ summary: 'Category context', audience: 'Designers', insights: [
      { title: 'Known category', detail: 'Source-supported context', kind: 'evidence', sourceUrls: ['https://example.com/research'] },
      { title: 'Unverified', detail: 'Try a novel hook', kind: 'evidence', sourceUrls: ['https://made-up.example/'] },
    ], sources: [{ title: 'Research', url: 'https://example.com/research' }, { title: 'Invented', url: 'https://made-up.example/' }] }, [{ type: 'web_search_call', action: { sources: [{ url: 'https://example.com/research', title: 'Research' }] } }]));
  });
  const findings = await research(brief);
  assert.equal(findings.sources.length, 1);
  assert.equal(findings.insights[0].kind, 'evidence');
  assert.equal(findings.insights[1].kind, 'hypothesis');
});

test('live concept copywriting preserves engine-created inherited genomes', async t => {
  config(t);
  const concepts = [{ genome: draft.genome, headline: draft.headline, body: draft.body, cta: draft.cta }];
  t.mock.method(globalThis, 'fetch', async () => Response.json(response({ concepts })));
  assert.deepEqual((await generateConcepts(brief, {}, { count: 1, parents: [draft] }))[0].genome, draft.genome);
  concepts[0] = { ...concepts[0], genome: { ...draft.genome, hook: 'changed-without-permission' } };
  await assert.rejects(generateConcepts(brief, {}, { count: 1, parents: [draft] }), /changed an inherited genome/);
});

test('live failure is explicit and does not leak provider response or secrets', async t => {
  config(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'secret upstream internal details' } }, { status: 401 }));
  await assert.rejects(research(brief), error => /HTTP 401/.test(error.message) && !/secret/.test(error.message));
  delete process.env.OPENAI_API_KEY;
  assert.equal(capabilities().liveResearch, false);
  await assert.rejects(research(brief), /OPENAI_API_KEY/);
});

async function experimentalConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'evolve-scorer-test-'));
  const reference = referenceFixture(), bytes = JSON.stringify(reference);
  await writeFile(join(dir, 'reference.json'), bytes);
  await writeFile(join(dir, 'reference.sha256'), sha256(bytes));
  config(t, { TRIBE_REFERENCE_PATH: join(dir, 'reference.json'), EVALUATION_CACHE_DIR: join(dir, 'cache') });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return reference;
}
const fakePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 4, 0, 8, 2]);

test('actual image features replace decoder calls and persist across candidate IDs', async t => {
  const reference = await experimentalConfig(t);
  let featureCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes('/images/generations')) return Response.json({ data: [{ b64_json: fakePng.toString('base64') }] });
    featureCalls++;
    assert.equal(body.action, 'features');
    assert.equal(body.decoder_version, undefined);
    assert.equal(body.candidates[0].png_base64, fakePng.toString('base64'));
    return Response.json({ feature_spec_hash: reference.contract.feature_spec_hash, results: body.candidates.map(candidate => featureFixture(candidate, reference)) });
  });
  const asset = await renderCandidate(draft, brief);
  const first = (await scoreTribe([{ ...draft, asset }], brief))[0];
  assert.equal(first.neural.source, 'tribe-pattern-experimental');
  assert.equal(first.neural.confidence, null);
  assert.equal(first.emotions, undefined);
  const second = (await scoreTribe([{ ...draft, id: 'new-id', asset }], brief))[0];
  assert.equal(second.cached, true);
  assert.deepEqual(second.neural, first.neural);
  assert.equal(featureCalls, 1);
  await assert.rejects(scoreTribe([{ ...draft, asset: { ...asset, mediaHash: 'wrong' } }], brief), /hash mismatch/);
  await assert.rejects(scoreTribe([{ ...draft, asset: { url: '/assets/../../secrets.png' } }], brief), /actual generated PNG/);
});

test('image reviewer sees pixels, gates wrong copy and caches by media plus brief', async t => {
  await experimentalConfig(t);
  let reviews = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/images/generations')) return Response.json({ data: [{ b64_json: fakePng.toString('base64') }] });
    reviews++;
    const body = JSON.parse(options.body);
    assert.equal(body.text.format.name, 'render_review');
    assert.ok(body.input[1].content.some(item => item.type === 'input_image' && item.image_url.endsWith(fakePng.toString('base64'))));
    return Response.json(response({ quality: 90, briefAlignment: 80, observedText: 'Wrong headline',
      checks: { productVisible: true, copyReadable: true, copyAccurate: false, claimsSupported: true, noMajorDefects: true },
      reasons: ['Wrong headline'], visualTags: ['product closeup', 'green'] }));
  });
  const asset = await renderCandidate(draft, brief);
  assert.equal((await screenCandidate({ ...draft, asset }, brief)).passed, false);
  assert.equal((await screenCandidate({ ...draft, asset }, brief)).cached, true);
  assert.equal(reviews, 1);
  await screenCandidate({ ...draft, asset }, { ...brief, goal: 'Another goal' });
  assert.equal(reviews, 2);
});

test('worker protocol and image mismatches fail closed without caching invalid data', async t => {
  const reference = await experimentalConfig(t);
  let bad = 'media';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/images/generations')) return Response.json({ data: [{ b64_json: fakePng.toString('base64') }] });
    const candidate = JSON.parse(options.body).candidates[0], result = featureFixture(candidate, reference);
    if (bad === 'media') result.media_hash = 'wrong';
    else result.metadata = { ...result.metadata, protocol: 'new-5s-mps' };
    return Response.json({ feature_spec_hash: reference.contract.feature_spec_hash, results: [result] });
  });
  const asset = await renderCandidate(draft, brief);
  await assert.rejects(scoreTribe([{ ...draft, asset }], brief), /media validation/);
  bad = 'protocol';
  await assert.rejects(scoreTribe([{ ...draft, asset }], brief), /protocol mismatch/);
});

test('feature batches respect worker limit and duplicate rendered images reuse one evaluation', async t => {
  const reference = await experimentalConfig(t);
  const sizes = [];
  let imageNumber = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/images/generations')) return Response.json({ data: [{ b64_json: Buffer.concat([fakePng, Buffer.from([++imageNumber])]).toString('base64') }] });
    const candidates = JSON.parse(options.body).candidates;
    sizes.push(candidates.length);
    return Response.json({ feature_spec_hash: reference.contract.feature_spec_hash, results: candidates.map(candidate => featureFixture(candidate, reference)) });
  });
  const candidates = [];
  for (let i = 0; i < 5; i++) candidates.push({ ...draft, id: String(i), asset: await renderCandidate(draft, brief) });
  candidates.push({ ...candidates[0], id: 'same-image-new-concept' });
  const results = await scoreTribe(candidates, brief);
  assert.deepEqual(sizes, [4, 1]);
  assert.equal(results.length, 6);
  assert.equal(results.filter(result => !result.cached).length, 5);
  assert.deepEqual(results[0].neural, results.at(-1).neural);
});

test('cancellation prevents provider calls', async t => {
  config(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected request'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(research(brief, { signal: controller.signal }), { name: 'AbortError' });
});
