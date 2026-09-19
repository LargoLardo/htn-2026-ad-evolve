import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilities, generateConcepts, renderCandidate, research, scoreTribe, screenCandidate } from '../lib/providers.mjs';
import { baselineFor, candidate, contract, fixture, isolatedConfig, openaiResponse, scoreResponse } from './helpers.mjs';

const brief = { product: 'Example', description: 'A reusable notebook', audience: 'Designers', goal: 'Discovery', mode: 'live', population: 1, mediaType: 'image' };
const draft = { id: 'candidate-1', round: 1, genome: { hook: 'question', visual: 'A notebook on a desk', emotion: 'curiosity', proof: 'Show the notebook', cta: 'Discover', palette: 'sage', motion: 'reveal', audio: 'quiet voice' }, headline: 'Your next idea', body: 'Make space for a fresh idea.', cta: 'Discover Example' };

test('live research requires search and ties evidence to actual returned sources', async t => {
  await isolatedConfig(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.tools[0].type, 'web_search');
    assert.equal(body.store, false);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(openaiResponse({ summary: 'Category context', audience: 'Designers', insights: [
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
  await isolatedConfig(t);
  const concepts = [{ genome: draft.genome, headline: draft.headline, body: draft.body, cta: draft.cta }];
  t.mock.method(globalThis, 'fetch', async () => Response.json(openaiResponse({ concepts })));
  assert.deepEqual((await generateConcepts(brief, {}, { count: 1, parents: [draft] }))[0].genome, draft.genome);
  concepts[0] = { ...concepts[0], genome: { ...draft.genome, hook: 'changed-without-permission' } };
  await assert.rejects(generateConcepts(brief, {}, { count: 1, parents: [draft] }), /changed an inherited genome/);
});

test('live failure is explicit and does not leak provider response or secrets', async t => {
  await isolatedConfig(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'secret upstream internal details' } }, { status: 401 }));
  await assert.rejects(research(brief), error => /HTTP 401/.test(error.message) && !/secret/.test(error.message));
  delete process.env.OPENAI_API_KEY;
  assert.equal(capabilities().liveResearch, false);
  await assert.rejects(research(brief), /OPENAI_API_KEY/);
});


test('image generation supplies actual pixels and scores persist across IDs', async t => {
  await isolatedConfig(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/images/generations')) return Response.json({ data: [{ b64_json: (await fixture('red.png')).toString('base64') }] });
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.action, 'percept');
    assert.equal(body.contract_hash, contract.hash);
    assert.equal(body.candidates[0].media_type, 'image');
    return Response.json(scoreResponse(body));
  });
  const asset = await renderCandidate(draft, brief);
  const first = await scoreTribe([{ ...draft, asset }], brief);
  const second = await scoreTribe([{ ...draft, id: 'another', asset }], brief);
  const third = await scoreTribe([{ ...draft, asset }], brief, { baseline: first.baseline });
  assert.equal(calls, 1);
  assert.deepEqual(second.results[0].neural, first.results[0].neural);
  assert.equal(second.results[0].cached, true);
  assert.equal(third.results[0].cached, true);
  assert.equal(first.results[0].neural.source, 'tribe-percept');
  await assert.rejects(scoreTribe([{ ...draft, asset: { ...asset, mediaHash: 'wrong' } }], brief), /hash mismatch/);
  await assert.rejects(scoreTribe([{ ...draft, asset: { url: '/assets/../../secret.png' } }], brief), /actual PNG or MP4/);
});

test('one fixed baseline, bounded batches and duplicate-media reuse', async t => {
  await isolatedConfig(t);
  const sizes = [], references = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); sizes.push(body.candidates.length); references.push(body.baseline?.hash);
    return Response.json(scoreResponse(body));
  });
  const candidates = [];
  for (const color of ['red', 'blue', 'green', 'yellow', 'purple']) candidates.push(await candidate(color, `${color}.png`));
  candidates.push({ ...candidates[0], id: 'same-media' });
  const first = await scoreTribe(candidates, brief);
  assert.deepEqual(sizes, [1, 4]);
  assert.deepEqual(references, [undefined, first.baseline.hash]);
  assert.equal(first.results.length, 6);
  assert.equal(first.results.at(-1).cached, true);
  assert.ok(first.results.every(r => r.neural.baselineHash === first.baseline.hash));
  const otherBaseline = baselineFor(candidates[1].asset.mediaHash);
  await scoreTribe([candidates[0]], brief, { baseline: otherBaseline });
  assert.equal(sizes.length, 3, 'a different original cannot reuse a score from the first original');
  await scoreTribe([candidates[0]], brief, { baseline: otherBaseline });
  assert.equal(sizes.length, 3);
});

test('video payloads are bounded to one clip per worker request', async t => {
  await isolatedConfig(t);
  const video = await candidate('video', 'sample.mp4'), still = await candidate('still');
  const sizes = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); sizes.push(body.candidates.length);
    if (body.candidates[0].id === 'video') assert.equal(body.candidates[0].media_type, 'video');
    return Response.json(scoreResponse(body));
  });
  const result = await scoreTribe([video, still], brief);
  assert.deepEqual(sizes, [1, 1]);
  assert.equal(result.baseline.mediaHash, video.asset.mediaHash);
});

test('invalid baseline, runtime, protocol and media results are rejected before caching', async t => {
  await isolatedConfig(t);
  const one = await candidate();
  let corrupt = response => { response.results[0].media_hash = 'wrong'; };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const response = scoreResponse(JSON.parse(options.body)); corrupt(response); return Response.json(response);
  });
  await assert.rejects(scoreTribe([one], brief), /media identity/);
  corrupt = r => { r.results[0].metadata.protocol = 'old-pooled'; };
  await assert.rejects(scoreTribe([one], brief), /protocol/);
  corrupt = r => { r.results[0].metadata.runtime_versions = { torch: 'changed' }; };
  await assert.rejects(scoreTribe([one], brief), /runtime changed/);
  corrupt = r => { r.baseline.statsF64 = 'AAAA' + r.baseline.statsF64.slice(4, -4) + 'AAAA'; };
  await assert.rejects(scoreTribe([one], brief), /checksum/);
  corrupt = () => {};
  assert.equal((await scoreTribe([one], brief)).results[0].cached, false);
  const cache = process.env.EVALUATION_CACHE_DIR;
  for (const file of await readdir(cache)) {
    const saved = JSON.parse(await readFile(join(cache, file))); saved.baseline.hash = '0'.repeat(64);
    await writeFile(join(cache, file), JSON.stringify(saved));
  }
  await assert.rejects(scoreTribe([one], brief), /checksum/);
});

test('review sees actual image pixels, fails wrong copy and caches by brief', async t => {
  await isolatedConfig(t);
  const item = { ...draft, ...(await candidate()) };
  let reviews = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    reviews++;
    const body = JSON.parse(options.body);
    assert.equal(body.text.format.name, 'render_review');
    assert.equal(body.input[1].content.filter(i => i.type === 'input_image').length, 1);
    return Response.json(openaiResponse({ quality: 90, briefAlignment: 80, observedText: 'Wrong headline',
      checks: { productVisible: true, copyReadable: true, copyAccurate: false, claimsSupported: true, noMajorDefects: true },
      reasons: ['Wrong headline'], visualTags: ['product closeup', 'green'] }));
  });
  assert.equal((await screenCandidate(item, brief)).passed, false);
  assert.equal((await screenCandidate(item, brief)).cached, true);
  assert.equal(reviews, 1);
  await screenCandidate(item, { ...brief, goal: 'Another goal' });
  assert.equal(reviews, 2);
});

test('video review provides six sampled frames plus a multipart audio transcript', async t => {
  await isolatedConfig(t);
  const item = { ...draft, ...(await candidate('video', 'sample.mp4')), original: true };
  let transcriptions = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/audio/transcriptions')) {
      transcriptions++;
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('model'), 'whisper-1');
      assert.ok(options.body.get('file').size > 0);
      return Response.json({ text: 'Meet Example.' });
    }
    const content = JSON.parse(options.body).input[1].content;
    assert.equal(content.filter(i => i.type === 'input_image').length, 6);
    assert.match(content[0].text, /Meet Example/);
    assert.match(content[0].text, /"requiredCopy":null/);
    return Response.json(openaiResponse({ quality: 80, briefAlignment: 80, observedText: 'Example', checks: { productVisible: true, copyReadable: true, copyAccurate: true, claimsSupported: true, noMajorDefects: true }, reasons: [], visualTags: ['notebook'] }));
  });
  const result = await screenCandidate(item, brief);
  assert.equal(result.evidenceScope, 'six-sampled-frames-and-audio-transcript');
  assert.equal(result.sampleTimes.length, 6);
  assert.equal(result.transcript, 'Meet Example.');
  await screenCandidate(item, brief);
  assert.equal(transcriptions, 1);
});

test('cancellation prevents provider calls', async t => {
  await isolatedConfig(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected request'); });
  const signal = AbortSignal.abort();
  await assert.rejects(research(brief, { signal }), { name: 'AbortError' });
  await assert.rejects(scoreTribe([], brief, { signal }), { name: 'AbortError' });
});
