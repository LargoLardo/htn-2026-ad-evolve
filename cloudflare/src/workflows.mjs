import { WorkflowEntrypoint } from 'cloudflare:workers';
import { evolveRun } from '../../lib/evolution.mjs';
import { impactNotes } from '../../lib/grid.mjs';
import { cloudProviders } from './providers.mjs';
import { runDocument } from './storage.mjs';
import { scoreQueued } from './neural-queue.mjs';
import { mapAsset, saveMap } from './maps.mjs';
import { isInterruption } from './interruption.mjs';

export class EvolutionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const context = { ...event.payload, workflowId: event.instanceId, kind: 'evolution' };
    // A deploy or transient RPC failure can permanently break a DO stub.
    // Each call (including a retried step) must obtain a fresh connection.
    const doc = () => runDocument(this.env, context.accountId, context.runId);
    const run = await step.do('initial-run', () => doc().initial());
    if (!run) throw new Error('Run document not found.');
    const checkpoint = () => doc().assertActive();
    const providers = cloudProviders(this.env, context.accountId, { step, checkpoint });
    const live = { ...providers };
    const calls = new Map(); let revision = 0;
    for (const name of ['research', 'generateConcepts', 'describeReferences', 'readImpactNotes', 'screenCandidate', 'renderCandidate']) {
      live[name] = async (...args) => {
        const index = (calls.get(name) || 0) + 1; calls.set(name, index);
        if (name === 'renderCandidate' && run.brief.mediaType === 'video') return providers[name](...args);
        // Parallel renders/reviews may complete in a different order on replay.
        // Associate their durable results with the candidate, never arrival order.
        const key = ['renderCandidate', 'screenCandidate'].includes(name) ? args[0].id : index;
        return step.do(`${name}-${key}`, { timeout: '8 minutes', retries: { limit: ['renderCandidate', 'generateConcepts', 'research'].includes(name) ? 0 : 2, delay: '15 seconds' } }, async () => { await checkpoint(); return providers[name](...args); });
      };
    }
    let scoreCall = 0;
    live.scoreTribe = (candidates, brief, options) => scoreQueued(this.env, context, step, `score-${++scoreCall}`, candidates, brief, options);
    await evolveRun(run, live, {
      isInterruption,
      onUpdate: async snapshot => {
        const recorded = await step.do(`save-${++revision}`, async () => {
          await doc().save(snapshot);
          return { events: snapshot.events, elapsedMs: snapshot.metrics.elapsedMs };
        });
        snapshot.events = recorded.events; snapshot.metrics.elapsedMs = recorded.elapsedMs;
      },
      chooseParents: async ({ run, round, eligibleIds, suggestedIds }) => {
        let note = run.brief.impactNotes || '';
        if (run.brief.feedbackEveryRound && run.brief.mediaType === 'image') {
          const winner = run.rounds.at(-1).candidates.find(c => c.id === suggestedIds[0]);
          const result = await mapAsset(this.env, context, step, `round-${round}-feedback`, winner.asset, run.brief, {});
          const measured = impactNotes(result.elements);
          note = [note, `Round ${round}: ${measured}`].filter(Boolean).join('\n').slice(-8000);
          await step.do(`round-${round}-feedback-save`, () => saveMap(this.env, context.accountId, winner.asset, run.id, `Round ${round}`, result, 0));
        }
        // Both policies resolve through the same validated decision shape.
        if (run.brief.selectionPolicy !== 'manual') return { parentIds: suggestedIds, killedIds: [], note };
        const gate = await step.do(`round-${round}-gate`, async () => { await doc().save(run); return doc().openGate({ round, eligibleIds, suggestedIds, note }); });
        await step.waitForEvent(`round-${round}-decision`, { type: `round-${round}`, timeout: '30 days' });
        return step.do(`round-${round}-apply-decision`, () => doc().closeGate(gate.token));
      },
    });
    return { id: run.id, status: run.status };
  }
}

export class MapWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const context = { ...event.payload, workflowId: event.instanceId, kind: 'map' };
    const doc = () => runDocument(this.env, context.accountId, context.runId);
    const { job, brief } = await step.do('initial-map', async () => ({ job: await doc().maps(), brief: (await doc().get()).brief }));
    for (const [index, target] of job.targets.entries()) {
      try {
        target.status = 'running';
        await step.do(`target-${index}-start`, () => doc().saveMaps(job));
        const result = await mapAsset(this.env, context, step, `target-${index}`, target.asset, brief, {
          onProgress: async progress => { Object.assign(target, progress); await doc().saveMaps(job); },
        });
        await step.do(`target-${index}-save`, () => saveMap(this.env, context.accountId, target.asset, context.runId, target.label, result, Date.now() - Date.parse(job.startedAt)));
        target.status = result.impact ? 'done' : 'attention-only'; target.error = result.impactError || null;
        if (result.impact) target.done = target.total = result.impact.regions.length;
      } catch (error) { if (isInterruption(error)) throw error; target.status = 'failed'; target.error = error.message; }
        await step.do(`target-${index}-finish`, () => doc().saveMaps(job));
    }
    job.status = job.targets.some(t => ['done', 'attention-only'].includes(t.status)) ? 'complete' : 'failed';
    await step.do('map-finish', () => doc().saveMaps(job));
    return { runId: context.runId, status: job.status };
  }
}
