import { sha256, stable } from '../../lib/scoring-validation.mjs';
import { accountStore, runDocument } from './storage.mjs';
import { cloudProviders } from './providers.mjs';

export async function scoreQueued(env, context, step, name, candidates, brief, { baseline, contractHash } = {}) {
  const store = accountStore(env, context.accountId), results = []; let calls = 0;
  for (const candidate of candidates) {
    const id = sha256(stable([context.workflowId, name, candidate.id, candidate.asset.mediaHash, baseline?.hash || 'self', contractHash]));
    const eventType = `neural-${id.slice(0, 48)}`;
    const queueStep = `${name}-${candidate.id}`;
    await step.do(`${queueStep}-enqueue`, async () => {
      await runDocument(env, context.accountId, context.runId).assertActive();
      await store.putJson(`jobs/${id}.json`, { candidate, brief, baseline, contractHash });
      await env.NEURAL.send({ ...context, jobId: id, eventType });
    });
    await step.waitForEvent(`${queueStep}-ready`, { type: eventType, timeout: '2 hours' });
    const scored = await step.do(`${queueStep}-result`, async () => {
      const response = await store.getJson(`results/${id}.json`);
      if (!response) throw new Error('Neural evaluation did not save its result.');
      if (response.error) throw new Error(response.error);
      return response;
    });
    if (baseline && scored.baseline.hash !== baseline.hash) throw new Error('The original baseline changed.');
    baseline = scored.baseline; calls += scored.calls; results.push(...scored.results);
  }
  return { baseline, calls, results };
}

async function ready(env) {
  const endpoint = env.TRIBE_SCORE_URL || env.BASETEN_TRIBE_ENDPOINT;
  const match = /^https:\/\/model-([a-z0-9]+)\.api\.baseten\.co\/deployment\/([a-z0-9]+)\/predict$/.exec(endpoint || '');
  const target = Number(env.TRIBE_CONCURRENCY || 1);
  if (!Number.isInteger(target) || target < 1 || target > 8) throw new Error('Invalid TRIBE concurrency.');
  if (!match) { if (target !== 1) throw new Error('Replica readiness cannot be verified for this endpoint.'); return true; }
  const headers = { Authorization: `Api-Key ${env.BASETEN_API_KEY}` };
  const response = await fetch(`https://api.baseten.co/v1/models/${match[1]}/deployments/${match[2]}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Baseten readiness returned HTTP ${response.status}.`);
  const state = await response.json();
  if (state.active_replica_count >= target && state.status === 'ACTIVE') return true;
  if (!state.active_replica_count) {
    // Wake requests do not change min_replica, so idle scaling remains enabled.
    try { await fetch(endpoint.replace(/\/predict$/, '/wake'), { method: 'POST', headers, signal: AbortSignal.timeout(10_000) }); } catch { /* queue retries while starting */ }
  }
  return false;
}

export async function consumeNeural(batch, env) {
  // max_batch_size and max_concurrency are both 1 in the deployed configuration.
  for (const message of batch.messages) {
    const task = message.body, store = accountStore(env, task.accountId);
    try {
      const run = await runDocument(env, task.accountId, task.runId).get();
      if (!run || run.status === 'cancelled') { message.ack(); continue; }
      let result = await store.getJson(`results/${task.jobId}.json`);
      if (!result) {
        if (!await ready(env)) {
          if (message.attempts >= 8) throw new Error('Baseten replicas did not become ready before the retry limit.');
          message.retry({ delaySeconds: 60 }); continue;
        }
        const job = await store.getJson(`jobs/${task.jobId}.json`);
        if (!job?.candidate) throw new Error('Neural evaluation request is missing.');
        result = await cloudProviders(env, task.accountId).scoreTribe([job.candidate], job.brief, { baseline: job.baseline, contractHash: job.contractHash });
        await store.putJson(`results/${task.jobId}.json`, result);
      }
      const binding = task.kind === 'map' ? env.MAP_BUILD : env.EVOLUTION;
      await (await binding.get(task.workflowId)).sendEvent({ type: task.eventType, payload: { jobId: task.jobId } });
      message.ack();
    } catch (error) {
      const permanent = /HTTP (401|403|404|422)|baseline|contract|identity|must contain|missing/i.test(error.message);
      if (!permanent && message.attempts < 8) { message.retry({ delaySeconds: 30 }); continue; }
      // A notification failure must never replace an already-saved paid result.
      if (!await store.getJson(`results/${task.jobId}.json`)) await store.putJson(`results/${task.jobId}.json`, { error: error.message });
      try {
        const binding = task.kind === 'map' ? env.MAP_BUILD : env.EVOLUTION;
        await (await binding.get(task.workflowId)).sendEvent({ type: task.eventType, payload: { jobId: task.jobId } });
        message.ack();
      } catch { message.retry({ delaySeconds: 30 }); }
    }
  }
}
