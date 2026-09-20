import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { createRun, validateBrief } from '../../lib/evolution.mjs';
import { sha256, stable, FAMILY_KEYS } from '../../lib/scoring-validation.mjs';
import { accountStore, runDocument } from '../src/storage.mjs';
import { getScoringContract } from '../src/contract.mjs';
import { consumeNeural } from '../src/neural-queue.mjs';

beforeAll(() => applyD1Migrations(env.INDEX, env.MIGRATIONS));
afterEach(() => vi.restoreAllMocks());
const contract = getScoringContract();
const brief = validateBrief({ product: 'Notebook', description: 'Reusable paper notebook' });
function scoreResponse(body) {
  const runtime = { torch: 'TEST' }, stats = Buffer.alloc(2 * 20484 * 8);
  for (let i = 20484; i < 40968; i++) stats.writeDoubleLE(1, i * 8);
  const metadata = { mediaHash: body.candidates[0].media_hash, predictionHash: sha256('prediction'), contractHash: contract.hash, runtimeVersions: runtime, statsSha256: sha256(stats) };
  const baseline = body.baseline || { ...metadata, hash: sha256(stable(metadata)), statsF64: stats.toString('base64') };
  return { contract_hash: contract.hash, baseline, results: body.candidates.map(c => ({ id: c.id, media_hash: c.media_hash,
    neural: { source: 'tribe-percept', version: contract.version, contractHash: contract.hash, baselineHash: baseline.hash, baselineMediaHash: baseline.mediaHash, engagementScore: 50, frames: 2, duration: 10, regions: FAMILY_KEYS.map(key => ({ key, name: key, score: 50, values: [45, 55] })), global: [45, 55], provenance: 'TEST' },
    metadata: { runtime_versions: runtime, protocol: contract.protocol, percept_revision: contract.percept_revision, prediction_hash: sha256('prediction') } })) };
}
async function setup() {
  const accountId = sha256(crypto.randomUUID()), store = accountStore(env, accountId);
  const run = createRun(brief); run.status = 'completed'; run.stage = 'complete';
  await runDocument(env, accountId, run.id).initialize(accountId, run);
  const bytes = Buffer.from('fixture media'), hash = sha256(bytes);
  const asset = { url: `/assets/${hash}.png`, mediaHash: hash, mediaType: 'image' };
  await env.MEDIA.put(store.key(`${hash}.png`), bytes); await store.putJson(`metadata/${hash}.json`, asset);
  const body = { accountId, runId: run.id, workflowId: 'test-workflow', kind: 'evolution', eventType: 'neural-test', jobId: sha256('job') };
  await store.putJson(`jobs/${body.jobId}.json`, { candidate: { id: 'one', asset }, brief, contractHash: contract.hash });
  const sendEvent = vi.fn(async () => {}), binding = { get: async () => ({ sendEvent }) };
  const options = { ...env, EVOLUTION: binding, TRIBE_SCORE_URL: 'https://tribe.test/predict' };
  return { store, body, options, sendEvent, bytes };
}
const message = body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() });

it('streams one stimulus, validates its baseline and reuses saved results on redelivery', async () => {
  const { store, body, options, sendEvent, bytes } = await setup();
  const inference = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const payload = await new Response(init.body).json();
    expect(payload.candidates).toHaveLength(1);
    expect(payload.action).toBe('percept');
    expect(Buffer.from(payload.candidates[0].media_base64, 'base64')).toEqual(bytes);
    return Response.json(scoreResponse(payload));
  });
  const first = message(body); await consumeNeural({ messages: [first] }, options);
  expect(first.ack).toHaveBeenCalledOnce(); expect(inference).toHaveBeenCalledOnce();
  const saved = await store.getJson(`results/${body.jobId}.json`);
  expect(saved.baseline.statsF64.length).toBe(436992);
  expect(saved.results[0].neural.engagementScore).toBe(50);
  sendEvent.mockRejectedValueOnce(new Error('Notification temporarily unavailable'));
  const duplicate = message(body); await consumeNeural({ messages: [duplicate] }, options);
  expect(duplicate.retry).toHaveBeenCalledOnce(); expect(inference).toHaveBeenCalledOnce();
  expect(await store.getJson(`results/${body.jobId}.json`)).toEqual(saved);
  const again = message(body); await consumeNeural({ messages: [again] }, options);
  expect(again.ack).toHaveBeenCalledOnce(); expect(inference).toHaveBeenCalledOnce();
});

it('waits for the requested active replica count before sending any stimulus', async () => {
  const { body, options } = await setup();
  options.TRIBE_SCORE_URL = 'https://model-testmodel.api.baseten.co/deployment/testdeploy/predict';
  options.TRIBE_CONCURRENCY = '4'; options.BASETEN_API_KEY = 'TEST';
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => { calls.push(String(url)); return Response.json({ status: 'ACTIVE', active_replica_count: 1 }); });
  const pending = message(body); await consumeNeural({ messages: [pending] }, options);
  expect(pending.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  expect(calls).toEqual(['https://api.baseten.co/v1/models/testmodel/deployments/testdeploy']);
  expect(pending.ack).not.toHaveBeenCalled();
});
