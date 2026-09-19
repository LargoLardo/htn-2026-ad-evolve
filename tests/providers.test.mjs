import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capabilities, generateConcepts, renderCandidate, research, scoreTribe } from '../lib/providers.mjs';

const brief = { product: 'Example', description: 'A reusable notebook', audience: 'Designers', goal: 'Discovery', mode: 'live', population: 1 };
const draft = { id: 'candidate-1', round: 1, genome: { hook: 'question', visual: 'A notebook on a desk', emotion: 'curiosity', proof: 'Show the notebook', cta: 'Discover', palette: 'sage' }, headline: 'Your next idea', body: 'Make space for a fresh idea.', cta: 'Discover Example' };
const response = (parsed, extra = []) => ({ status: 'completed', output: [...extra, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(parsed), annotations: [] }] }] });
function config(t, values = {}) {
  const old = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: 'test-secret-do-not-display', TRIBE_URL: 'http://127.0.0.1:8091', TRIBE_DECODER_VERSION: 'test-head', ...values });
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

test('image bytes persist and TRIBE rejects identity and media mismatches', async t => {
  config(t);
  const fakePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 4, 0]);
  let wrongMedia = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes('/images/generations')) {
      assert.equal(body.quality, 'low');
      return Response.json({ data: [{ b64_json: fakePng.toString('base64') }] });
    }
    assert.equal(body.candidates[0].png_base64, fakePng.toString('base64'));
    return Response.json({ decoder_version: 'test-head', scores: [{ id: draft.id, media_hash: wrongMedia ? 'wrong' : body.candidates[0].media_hash, emotions: { joy: 45, trust: 60, curiosity: 70, desire: 55 }, confidence: null, provenance: 'Fitted test decoder', metadata: { uncertainty: 'not-estimated' } }] });
  });
  const asset = await renderCandidate(draft, brief);
  assert.equal(asset.kind, 'ai-generated-image');
  assert.deepEqual(await readFile(`data${asset.url}`), fakePng);
  assert.equal((await scoreTribe([{ ...draft, asset }], brief))[0].confidence, null);
  wrongMedia = true;
  await assert.rejects(scoreTribe([{ ...draft, asset }], brief), /validation/);
  await assert.rejects(scoreTribe([{ ...draft, asset: { url: '/assets/../../secrets.png' } }], brief), /actual generated PNG/);
});

test('cancellation prevents provider calls', async t => {
  config(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected request'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(research(brief, { signal: controller.signal }), { name: 'AbortError' });
});
