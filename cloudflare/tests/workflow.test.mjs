import { beforeAll, expect, it } from 'vitest';
import { env, applyD1Migrations, introspectWorkflowInstance, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { createRun, validateBrief } from '../../lib/evolution.mjs';
import { sha256, stable } from '../../lib/scoring-validation.mjs';
import { getScoringContract } from '../src/contract.mjs';
import { runDocument } from '../src/storage.mjs';
import { MapWorkflow } from '../src/workflows.mjs';

beforeAll(() => applyD1Migrations(env.INDEX, env.MIGRATIONS));

it('reconnects to the run document when a deployment reset poisons an RPC stub', async () => {
  let reset = false, saved = false, connections = 0;
  const bindings = { RUNS: {
    idFromName: name => name,
    get() {
      connections++;
      let broken = false;
      return {
        maps: async () => ({ targets: [] }),
        get: async () => ({ brief: {} }),
        async saveMaps() {
          if (!reset || broken) {
            reset = broken = true;
            throw new Error('Durable Object reset because its code was updated.');
          }
          saved = true;
        },
      };
    },
  } };
  const step = { async do(name, callback) {
    try { return await callback(); }
    catch { return callback(); }
  } };
  await MapWorkflow.prototype.run.call({ env: bindings }, { payload: { accountId: sha256('rpc-reset'), runId: crypto.randomUUID() }, instanceId: 'rpc-reset' }, step);
  expect(saved).toBe(true);
  expect(connections).toBeGreaterThan(1);
});

it('runs the shared engine through a durable human gate and resumes after eviction', async () => {
  const accountId = sha256('workflow-owner');
  const brief = { ...validateBrief({ product: 'Notebook', description: 'Reusable paper notebook', rounds: 2, population: 4, shortlist: 1 }), selectionPolicy: 'manual' };
  const run = createRun(brief), doc = runDocument(env, accountId, run.id);
  const workflowId = `e-${accountId.slice(0, 16)}-${run.id}`;
  const test = await introspectWorkflowInstance(env.EVOLUTION, workflowId);
  const hash = sha256('pixels'), contract = getScoringContract(), id = n => `${run.id.slice(0, 8)}-${n}`;
  const asset = { url: `/assets/${hash}.png`, mediaHash: hash, mediaType: 'image', width: 64, height: 64, duration: 10 };
  const baseline = { hash: sha256('baseline'), mediaHash: hash, contractHash: contract.hash };
  try {
    await test.modify(async m => {
      await m.disableRetryDelays();
      await m.mockStepResult({ name: 'research-1' }, { summary: 'Fixture research', insights: [], sources: [], provenance: 'TEST' });
      for (let round = 1; round <= 2; round++) await m.mockStepResult({ name: `generateConcepts-${round}` }, Array.from({ length: round === 1 ? 4 : 3 }, (_, i) => ({ headline: `Route ${round}-${i}`, body: brief.description, cta: 'Discover' })));
      for (let n = 1; n <= 8; n++) {
        await m.mockStepResult({ name: `renderCandidate-${id(n)}` }, asset);
        await m.mockStepResult({ name: `screenCandidate-${id(n)}` }, { mediaHash: hash, quality: n === 1 ? 95 : 80, briefAlignment: 80, checks: { productVisible: true, copyReadable: true, copyAccurate: true, claimsSupported: true, noMajorDefects: true }, observedText: 'Notebook', reasons: [], visualTags: ['notebook'], provenance: 'TEST' });
      }
      const jobId = sha256(stable([workflowId, 'score-1', id(1), hash, 'self', contract.hash]));
      await m.mockStepResult({ name: `score-1-${id(1)}-enqueue` }, null);
      await m.mockEvent({ type: `neural-${jobId.slice(0, 48)}`, payload: { jobId } });
      await m.mockStepResult({ name: `score-1-${id(1)}-result` }, { baseline, calls: 1, results: [{ id: id(1), mediaHash: hash, neural: { source: 'tribe-neural', engagementScore: 50, baselineHash: baseline.hash, baselineMediaHash: hash, contractHash: contract.hash, provenance: 'TEST' } }] });
    });
    await doc.initialize(accountId, run);
    await runInDurableObject(doc, async (_, state) => { await state.storage.deleteAlarm(); await state.storage.put('started', true); });
    const instance = await env.EVOLUTION.create({ id: workflowId, params: { accountId, runId: run.id } });
    const gate = await test.waitForStepResult({ name: 'round-1-gate' });
    expect((await doc.get()).stage).toBe('awaiting-selection');
    expect((await doc.get()).rounds).toHaveLength(1);
    await instance.pause(); await evictDurableObject(doc); await instance.resume();
    await doc.decide({ token: gate.token, round: 1, parentIds: gate.suggestedIds, killedIds: [], note: 'Use a quieter composition.' });
    await runDurableObjectAlarm(doc);
    await test.waitForStatus('complete');
    const finished = await doc.get();
    expect(finished.status, finished.error).toBe('completed');
    expect(finished.rounds).toHaveLength(2);
    expect(finished.brief.impactNotes).toBe('Use a quieter composition.');
    expect(finished.metrics.tribeCalls).toBe(1);
    expect(finished.events.filter(e => e.message.startsWith('Researching'))).toHaveLength(1);
  } finally { await test.dispose(); }
});
