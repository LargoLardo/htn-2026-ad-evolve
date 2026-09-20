import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from '../server.mjs';
import { ffmpeg, getUploadedAsset, ingestMedia, mediaPayload } from '../lib/media.mjs';
import { fixture, isolatedConfig } from './helpers.mjs';
const input = { product: 'Notebook', description: 'A reusable notebook', goal: 'Discover', rounds: 2, population: 4, shortlist: 2, mediaType: 'video' };

test('media ingestion validates real files, dimensions, duration and content identity', async t => {
  const dir = await isolatedConfig(t);
  const asset = await ingestMedia(await fixture('red.png'), 'image/png');
  assert.equal(asset.duration, 10);
  assert.deepEqual(await getUploadedAsset(asset.mediaHash), asset);
  await assert.rejects(ingestMedia(Buffer.from('not an image'), 'image/png'), /dimensions/);
  await assert.rejects(ingestMedia(await fixture('red.png'), 'image/svg+xml'), /PNG, JPEG/);
  await assert.rejects(ingestMedia(await fixture('red.png'), 'video/mp4'), /MP4 video/);
  const short = join(dir, 'short.mp4');
  await ffmpeg(['-f','lavfi','-i','color=s=32x32:r=25','-t','0.2','-c:v','libx264',short]);
  await assert.rejects(ingestMedia(await readFile(short), 'video/mp4'), /1 and 60/);
  await writeFile(join(process.env.EVOLVE_ASSETS_DIR, asset.url.split('/').at(-1)), 'changed');
  await assert.rejects(mediaPayload({ id: 'one', asset }), /hash mismatch/);
});

test('upload, video seeking, original baseline and evolutionary API flow work together', async t => {
  const dir = await isolatedConfig(t);
  let baseline, originalHash, rendered = 0;
  const providers = {
    capabilities: () => ({ liveResearch: true, liveImages: true, liveVideos: true, tribe: true }),
    getNeuralConfig: () => ({ hash: 'contract', version: 'neural-test' }),
    research: async () => ({ insights: [], sources: [], summary: 'Test' }),
    generateConcepts: async (brief, research, { count, parents }) => {
      assert.equal(research.originalMedia.transcript, 'Original speech');
      return parents.length ? parents : Array.from({ length: count }, (_, i) => ({ genome: { hook: `hook ${i}`, visual: `visual ${i}`, emotion: 'joy', proof: 'notebook', cta: 'look', palette: 'green', motion: 'reveal', audio: 'voice' }, headline: `Take ${i}`, body: 'A notebook', cta: 'Discover' }));
    },
    renderCandidate: async (candidate, brief) => {
      assert.equal(candidate.original, undefined);
      assert.equal(brief.mediaType, 'video'); rendered++;
      return ingestMedia(await fixture('sample.mp4'), 'video/mp4');
    },
    screenCandidate: async c => ({ mediaHash: c.asset.mediaHash, quality: 80, briefAlignment: 80, checks: { productVisible: true, copyReadable: true, copyAccurate: true, claimsSupported: true, noMajorDefects: true }, observedText: 'Notebook', transcript: c.original ? 'Original speech' : 'New speech', reasons: [], visualTags: ['notebook'], provenance: 'TEST' }),
    scoreTribe: async (candidates, brief, options) => {
      if (!baseline) {
        assert.equal(candidates.length, 1); assert.equal(candidates[0].original, true);
        assert.equal(candidates[0].asset.mediaHash, originalHash);
        baseline = { hash: 'baseline', mediaHash: originalHash, contractHash: 'contract' };
      } else assert.deepEqual(options.baseline, baseline);
      return { baseline, calls: 1, results: candidates.map(c => ({ id: c.id, mediaHash: c.asset.mediaHash,
        neural: { source: 'tribe-neural', engagementScore: c.original ? 50 : 70, baselineHash: baseline.hash, baselineMediaHash: originalHash, contractHash: 'contract', provenance: 'TEST' } })) };
    },
  };
  const server = await createAppServer({ providers, dataDir: join(dir, 'runs') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const video = await fixture('sample.mp4');
  const uploaded = await fetch(base + '/api/media', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: video });
  assert.equal(uploaded.status, 201);
  const original = await uploaded.json(); originalHash = original.id;
  const range = await fetch(base + original.asset.url, { headers: { range: 'bytes=10-29' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), video.subarray(10, 30));
  const suffix = await fetch(base + original.asset.url, { headers: { range: 'bytes=-20' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), video.subarray(-20));
  const head = await fetch(base + original.asset.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(video.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(base + original.asset.url, { headers: { range: `bytes=${video.length}-` } })).status, 416);
  assert.equal((await fetch(base + '/api/media', { method: 'POST', headers: { origin: 'https://external.example', 'content-type': 'video/mp4' }, body: video })).status, 403);
  const start = brief => fetch(base + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(brief) });
  assert.equal((await start({ ...input, mediaType: 'image', originalMediaId: original.id })).status, 400);
  const created = await start({ ...input, originalMediaId: original.id });
  assert.equal(created.status, 202);
  let run = await created.json();
  for (let i = 0; run.status === 'running' && i < 100; i++) { await delay(20); run = await (await fetch(`${base}/api/runs/${run.id}`)).json(); }
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.neuralBaseline.mediaHash, originalHash);
  assert.equal(run.neuralBaseline.candidateId, run.originalId);
  assert.ok(rendered > 0 && rendered < input.rounds * input.population);
  assert.ok(run.metrics.tribeCandidates <= input.rounds * input.shortlist + 1);
  assert.equal(run.finalists[0].scores.neural.engagementScore, 70);
  assert.ok(run.finalists.every(c => c.scores.neural.baselineHash === baseline.hash));
  assert.equal(run.rounds.length, 2);
  const exported = await fetch(`${base}/api/runs/${run.id}/export`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(await exported.json(), run);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'runs', `${run.id}.json`))), run);
});
