import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ingestMedia, mediaPayload, MAX_MEDIA_BYTES } from './media.mjs';
import { sha256, stable } from './scoring-contract.mjs';

const BASE = 'https://api.dev.pika.art';
const MODEL = 'bytedance/seedance-2.0/text-to-video';
const cacheDir = () => resolve(process.env.EVALUATION_CACHE_DIR || 'data/evaluation-cache');
async function save(path, value) {
  await mkdir(cacheDir(), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value)); await rename(temp, path);
}
async function request(path, { signal, body, key } = {}) {
  const response = await fetch(BASE + path, { method: body ? 'POST' : 'GET',
    headers: { 'X-API-Key': process.env.PIKA_API_KEY, ...(body ? { 'content-type': 'application/json', 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]) });
  if (!response.ok) throw new Error(`Seedance/Pika returned HTTP ${response.status}. Check API access and balance.`);
  return response.json();
}
async function download(url, signal) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:') throw new Error('Pika returned a non-HTTPS media URL.');
    const response = await fetch(url, { redirect: 'manual',
      headers: url.origin === BASE ? { 'X-API-Key': process.env.PIKA_API_KEY } : {},
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180_000)]) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('Generated video download returned an invalid redirect.');
    url = new URL(location, url);
  }
  throw new Error('Generated video download exceeded the redirect limit.');
}
export async function renderVideo(prompt, brief, { signal } = {}) {
  signal?.throwIfAborted();
  if (!process.env.PIKA_API_KEY) throw new Error('Video generation requires PIKA_API_KEY.');
  // Pika's REST schema uses `ratio`; its older MCP guide says `aspect_ratio`.
  // Keep the exact generation profile in the cache/idempotency key.
  const body = { prompt, resolution: '720p', ratio: brief.aspectRatio, duration: brief.videoDuration };
  const key = sha256(stable([MODEL, body]));
  const path = resolve(cacheDir(), `seedance-${key}.json`);
  let job;
  try { job = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Video generation cache is unreadable.'); }
  if (job?.asset) { await mediaPayload({ id: 'cached', asset: job.asset }); return { ...job.asset, cached: true }; }
  if (!job?.id) {
    const created = await request(`/v1/media/${MODEL}`, { body, key, signal });
    if (typeof created.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(created.id)) throw new Error('Pika returned no valid video job ID.');
    job = { id: created.id };
    await save(path, job); // Cancelling polling preserves the submitted job.
  }
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const status = await request(`/v1/media/jobs/${job.id}`, { signal });
    if (status.status === 'failed') throw new Error('Seedance video generation failed. The saved job was retained for inspection.');
    if (status.status === 'completed') {
      const content = await request(`/v1/media/jobs/${job.id}/content`, { signal });
      let url;
      try { url = new URL(content.url); } catch { throw new Error('Pika returned an invalid media URL.'); }
      const response = await download(url, signal);
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_MEDIA_BYTES) throw new Error('Generated video download failed or exceeded 50 MiB.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > MAX_MEDIA_BYTES) throw new Error('Generated video exceeds 50 MiB.'); chunks.push(chunk); }
      const asset = await ingestMedia(Buffer.concat(chunks), 'video/mp4', { signal, kind: 'ai-generated-video', prompt, model: 'Seedance 2.0' });
      await save(path, { ...job, asset });
      return asset;
    }
    if (!['queued', 'running'].includes(status.status)) throw new Error('Pika returned an unknown job state.');
    await delay(3000, undefined, { signal });
  }
  throw new Error('Seedance generation timed out; the job ID is cached so a retry can resume polling.');
}
