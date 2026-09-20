import { DurableObject } from 'cloudflare:workers';
import { indexRun } from './storage.mjs';
import { validateParentDecision } from '../../lib/evolution.mjs';

const terminal = status => ['completed', 'complete', 'cancelled', 'failed', 'empty'].includes(status);
export class RunDocument extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.listeners = new Set(); }
  // Chunk the document: scores and traces can exceed the single-value storage limit.
  async read(name) {
    return this.ctx.storage.transaction(async tx => {
      const count = await tx.get(`${name}:count`);
      if (!count) return null;
      const chunks = [];
      for (let i = 0; i < count; i++) chunks.push(await tx.get(`${name}:${i}`));
      return JSON.parse(chunks.join(''));
    });
  }
  async write(name, value) {
    const text = JSON.stringify(value), size = 16000, count = Math.ceil(text.length / size);
    await this.ctx.storage.transaction(async tx => {
      const old = await tx.get(`${name}:count`) || 0;
      for (let i = 0; i < count; i++) await tx.put(`${name}:${i}`, text.slice(i * size, (i + 1) * size));
      for (let i = count; i < old; i++) await tx.delete(`${name}:${i}`);
      await tx.put(`${name}:count`, count);
    });
  }
  async initialize(accountId, run) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.read('run')) throw new Error('Run already exists.');
      await this.ctx.storage.put('accountId', accountId);
      run.workflowId = `e-${accountId.slice(0, 16)}-${run.id}`;
      await this.write('initial', run); await this.write('run', run);
      if (!terminal(run.status)) await this.ctx.storage.setAlarm(Date.now() + 1000);
      await indexRun(this.env, accountId, run);
      return run;
    });
  }
  get() { return this.read('run'); }
  initial() { return this.read('initial'); }
  async save(run) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.get();
      if (!stored || stored.id !== run.id) throw new Error('Run identity mismatch.');
      if (stored.status === 'cancelled') return stored;
      const pending = await this.read('gate');
      run.gate = pending;
      await this.write('run', run);
      await indexRun(this.env, await this.ctx.storage.get('accountId'), run);
      this.publish('run', run);
      return run;
    });
  }
  async assertActive() { const run = await this.get(); if (!run || run.status === 'cancelled') throw new Error('Run cancelled.'); }
  async openGate(gate) {
    const existing = await this.read('gate');
    if (existing?.round === gate.round) return existing;
    await this.assertActive();
    gate = { ...gate, token: crypto.randomUUID(), status: 'pending' };
    await this.write('gate', gate);
    const run = await this.get(); run.stage = 'awaiting-selection';
    await this.save(run); return gate;
  }
  async decide(input) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.assertActive();
      const gate = await this.read('gate');
      if (!gate || gate.token !== input.token || gate.round !== input.round) return { error: 'This round decision is no longer current.', status: 409 };
      const decision = { parentIds: input.parentIds, killedIds: input.killedIds || [], ...(input.note === undefined ? {} : { note: input.note }) };
      validateParentDecision(decision, gate.eligibleIds);
      if (gate.status !== 'pending') {
        return JSON.stringify(gate.decision) === JSON.stringify(decision) ? gate : { error: 'The decision was already submitted.', status: 409 };
      }
      Object.assign(gate, { status: 'submitted', decision });
      await this.write('gate', gate);
      await this.ctx.storage.put('gateOutbox', { round: gate.round, token: gate.token });
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      const run = await this.get(); run.gate = gate; await this.write('run', run); this.publish('run', run);
      return gate;
    });
  }
  async closeGate(token) {
    const gate = await this.read('gate');
    if (gate?.token !== token || !gate.decision) throw new Error('No valid saved round decision.');
    gate.status = 'resolved'; await this.write('gate', gate); return gate.decision;
  }
  async cancel() {
    return this.ctx.blockConcurrencyWhile(async () => {
    const run = await this.get();
    if (!run) return null;
    if (terminal(run.status)) return run;
    run.status = 'cancelled'; run.stage = 'cancelled'; run.error = 'Run cancelled.';
    await this.write('run', run);
    await indexRun(this.env, await this.ctx.storage.get('accountId'), run);
    this.publish('run', run);
    await this.ctx.storage.put('cancelOutbox', true);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return run;
    });
  }
  async startMaps() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.read('maps');
      if (existing?.status === 'running') return existing;
      const run = await this.get();
      if (!run) return null;
      if (run.status === 'running') throw new Error('Wait for the run to finish before building its maps.');
      const targets = [];
      const add = (asset, label) => { if (asset?.mediaType === 'image' && !targets.some(t => t.mediaHash === asset.mediaHash)) targets.push({ asset, mediaHash: asset.mediaHash, label, status: 'queued', done: 0, total: 0, cells: null }); };
      add(run.brief.originalAsset, 'Original');
      add([...run.finalists].sort((a, b) => b.scores.neural.engagementScore - a.scores.neural.engagementScore)[0]?.asset, 'Winner');
      const accountId = await this.ctx.storage.get('accountId');
      const job = { runId: run.id, workflowId: `m-${accountId.slice(0, 16)}-${crypto.randomUUID()}`, status: targets.length ? 'running' : 'empty', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), targets, error: null };
      await this.write('maps', job);
      if (targets.length) { await this.ctx.storage.put('mapsOutbox', job.workflowId); await this.ctx.storage.setAlarm(Date.now() + 1000); }
      this.publish('maps', job); return job;
    });
  }
  maps() { return this.read('maps'); }
  async saveMaps(job) { job.updatedAt = new Date().toISOString(); await this.write('maps', job); this.publish('maps', job); }
  async alarm() {
    try {
      const run = await this.get(), accountId = await this.ctx.storage.get('accountId');
      if (!run) return;
      if (await this.ctx.storage.get('cancelOutbox')) {
        if (await this.ctx.storage.get('started')) await (await this.env.EVOLUTION.get(run.workflowId)).terminate();
        await this.ctx.storage.delete('cancelOutbox'); return;
      }
      if (!terminal(run.status) && !await this.ctx.storage.get('started')) {
        try { await this.env.EVOLUTION.create({ id: run.workflowId, params: { accountId, runId: run.id } }); }
        catch (error) { try { await (await this.env.EVOLUTION.get(run.workflowId)).status(); } catch { throw error; } }
        await this.ctx.storage.put('started', true);
      }
      const pendingMap = await this.ctx.storage.get('mapsOutbox');
      if (pendingMap) {
        try { await this.env.MAP_BUILD.create({ id: pendingMap, params: { accountId, runId: run.id } }); }
        catch (error) { try { await (await this.env.MAP_BUILD.get(pendingMap)).status(); } catch { throw error; } }
        await this.ctx.storage.delete('mapsOutbox');
      }
      const decision = await this.ctx.storage.get('gateOutbox');
      if (decision) {
        await (await this.env.EVOLUTION.get(run.workflowId)).sendEvent({ type: `round-${decision.round}`, payload: { token: decision.token } });
        await this.ctx.storage.delete('gateOutbox');
      }
    } catch { await this.ctx.storage.setAlarm(Date.now() + 30_000); }
  }
  publish(kind, value) {
    for (const listener of this.listeners) if (listener.kind === kind) listener.send(value);
  }
  async fetch(request) {
    const kind = new URL(request.url).searchParams.get('kind') === 'maps' ? 'maps' : 'run';
    const initial = kind === 'maps' ? await this.maps() : await this.get();
    if (!initial) return new Response('Not found', { status: 404 });
    const encoder = new TextEncoder(); let listener, timer;
    const cleanup = () => { clearInterval(timer); this.listeners.delete(listener); };
    const body = new ReadableStream({
      start: controller => {
        listener = { kind, send: value => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); if (terminal(value.status)) { cleanup(); controller.close(); } }
          catch { cleanup(); }
        } };
        this.listeners.add(listener);
        timer = setInterval(() => { try { controller.enqueue(encoder.encode(': keep-alive\n\n')); } catch { cleanup(); } }, 15000);
        listener.send(initial);
      },
      cancel: cleanup,
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
  }
}
