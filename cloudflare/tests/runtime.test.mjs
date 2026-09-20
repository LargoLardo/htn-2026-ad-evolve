import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF, applyD1Migrations, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { encode } from 'fast-png';
import { createRun, validateBrief, validateParentDecision } from '../../lib/evolution.mjs';
import { sha256 } from '../../lib/scoring-validation.mjs';
import { getScoringContract } from '../src/contract.mjs';
import { accountStore, runDocument } from '../src/storage.mjs';
import { base64JsonStream, serveAsset, createMedia } from '../src/media.mjs';

beforeAll(() => applyD1Migrations(env.INDEX, env.MIGRATIONS));
const account = name => sha256(`local:${name}`);
const brief = () => validateBrief({ product: 'Notebook', description: 'A reusable notebook', goal: 'Discover', rounds: 2, population: 4, shortlist: 2 });
const request = (path, name, options = {}) => SELF.fetch(`http://localhost${path}`, { ...options, headers: { 'X-Local-Account': name, ...options.headers } });

describe('Cloudflare runtime', () => {
  it('loads the exact scoring contract without filesystem APIs', () => {
    expect(getScoringContract().hash).toBe('d5051effb6cc82842c7c7f8dbf21f7ea7854c57284b7e1cf46d8a86e2eba6576');
  });
  it('streams a base64 payload across arbitrary chunk boundaries', async () => {
    const bytes = new Uint8Array(10003).map((_, i) => i % 251);
    const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 17) c.enqueue(bytes.slice(i, i + 17)); c.close(); } });
    const json = await new Response(base64JsonStream(body, '{"media":"', '"}')).json();
    expect(Buffer.from(json.media, 'base64')).toEqual(Buffer.from(bytes));
  });
  it('isolates run documents, listings, assets and caches by account', async () => {
    const owner = account('owner'), stranger = account('stranger'), run = createRun(brief()); run.status = 'completed'; run.stage = 'complete';
    const doc = runDocument(env, owner, run.id);
    await doc.initialize(owner, run);
    expect((await (await request('/api/runs', 'owner')).json()).some(r => r.id === run.id)).toBe(true);
    expect((await (await request('/api/runs', 'stranger')).json()).some(r => r.id === run.id)).toBe(false);
    expect((await request(`/api/runs/${run.id}`, 'stranger')).status).toBe(404);
    const hash = sha256('private-media'), filename = `${hash}.mp4`;
    await env.MEDIA.put(`${owner}/${filename}`, 'private-media');
    expect((await request(`/assets/${filename}`, 'stranger')).status).toBe(404);
    expect(await (await request(`/assets/${filename}`, 'owner')).text()).toBe('private-media');
    await accountStore(env, owner).saveCachedJson('same-hash', { secret: 1 });
    expect(await accountStore(env, stranger).cachedJson('same-hash')).toBeNull();
  });
  it('serves bounded and suffix video ranges and rejects invalid ranges', async () => {
    const owner = account('range'), filename = `${sha256('range')}.mp4`;
    await env.MEDIA.put(`${owner}/${filename}`, '0123456789');
    const response = await serveAsset(new Request('http://localhost/a', { headers: { Range: 'bytes=2-4' } }), env, owner, filename);
    expect(response.status).toBe(206); expect(response.headers.get('Content-Range')).toBe('bytes 2-4/10'); expect(await response.text()).toBe('234');
    expect(await (await serveAsset(new Request('http://localhost/a', { headers: { Range: 'bytes=-3' } }), env, owner, filename)).text()).toBe('789');
    expect((await serveAsset(new Request('http://localhost/a', { headers: { Range: 'bytes=100-' } }), env, owner, filename)).status).toBe(416);
  });
  it('stores a document larger than a single storage value and survives a new stub', async () => {
    const owner = account('large'), run = createRun(brief()); run.status = 'completed'; run.stage = 'complete';
    run.research = { summary: '测'.repeat(100000) };
    await runDocument(env, owner, run.id).initialize(owner, run);
    await evictDurableObject(runDocument(env, owner, run.id));
    const loaded = await runDocument(env, owner, run.id).get();
    expect(loaded.research.summary).toBe(run.research.summary);
  });
  it('normalizes an upload to private PNG storage and rejects oversized uploads', async () => {
    const bytes = encode({ width: 24, height: 20, channels: 3, data: new Uint8Array(24 * 20 * 3).fill(42) });
    const owner = account('upload'), media = createMedia(env, owner);
    const asset = await media.ingestMedia(bytes, 'image/png');
    expect(asset.width).toBe(24); expect(asset.height).toBe(20); expect(asset.duration).toBe(10);
    expect(await media.getUploadedAsset(asset.mediaHash)).toEqual(asset);
    expect(sha256(Buffer.from(await (await env.MEDIA.get(`${owner}/${asset.mediaHash}.png`)).arrayBuffer()))).toBe(asset.mediaHash);
    expect((await request('/api/media', 'upload', { method: 'POST', headers: { 'Content-Type': 'image/png', 'Content-Length': String(21 * 1024 * 1024) }, body: bytes })).status).toBe(413);
  });
  it('recovers a gate after eviction, scopes decisions to its account and never revives cancellation', async () => {
    const run = createRun(brief()), owner = account('gate');
    const doc = runDocument(env, owner, run.id); await doc.initialize(owner, run);
    await runInDurableObject(doc, async (_, state) => { await state.storage.deleteAlarm(); await state.storage.put('started', true); });
    const gate = await doc.openGate({ round: 1, eligibleIds: ['a', 'b'], suggestedIds: ['a'], note: '' });
    await evictDurableObject(doc);
    expect((await doc.get()).gate.token).toBe(gate.token);
    const input = { token: gate.token, round: 1, parentIds: ['b'], killedIds: ['a'], note: 'Keep the headline concise.' };
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) };
    expect((await request(`/api/runs/${run.id}/decision`, 'stranger', options)).status).toBe(404);
    expect((await request(`/api/runs/${run.id}/decision`, 'gate', options)).status).toBe(200);
    expect((await doc.decide(input)).status).toBe('submitted');
    expect((await doc.decide({ ...input, parentIds: ['a'], killedIds: [] })).status).toBe(409);
    expect((await doc.closeGate(gate.token)).parentIds).toEqual(['b']);
    await doc.cancel(); await doc.save({ ...run, status: 'completed' });
    expect((await doc.get()).status).toBe('cancelled');
    await runInDurableObject(doc, (_, state) => state.storage.deleteAlarm());
  });
  it('refuses unverified hosted requests and cross-origin writes', async () => {
    expect((await SELF.fetch('https://hosted.example/api/runs', { headers: { 'X-Local-Account': 'owner' } })).status).toBe(503);
    expect((await request('/api/runs', 'owner', { method: 'POST', headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
  });
  it('cannot remove every parent or select an unreviewed or removed node', () => {
    const eligible = ['a', 'b'];
    expect(() => validateParentDecision({ parentIds: [], killedIds: ['a', 'b'] }, eligible)).toThrow();
    expect(() => validateParentDecision({ parentIds: ['a'], killedIds: ['a'] }, eligible)).toThrow();
    expect(() => validateParentDecision({ parentIds: ['foreign'], killedIds: [] }, eligible)).toThrow();
    expect(validateParentDecision({ parentIds: ['b'], killedIds: ['a'] }, eligible).parentIds).toEqual(['b']);
  });
});
