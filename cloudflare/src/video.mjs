import { sha256, stable } from '../../lib/scoring-validation.mjs';

const BASE = 'https://api.dev.pika.art';
const MODEL = 'bytedance/seedance-2.0/text-to-video';
export function createVideoProvider(env, media, store, { step, checkpoint } = {}) {
  return async function renderVideo(prompt, brief) {
    if (!step) throw new Error('Video generation must run inside a Workflow.');
    if (!env.PIKA_API_KEY) throw new Error('Video generation requires PIKA_API_KEY.');
    const body = { prompt, resolution: '720p', ratio: brief.aspectRatio, duration: brief.videoDuration };
    const idempotencyKey = sha256(stable([MODEL, body]));
    const key = `seedance-${idempotencyKey}`;
    const request = async (path, payload) => {
      await checkpoint();
      const response = await fetch(BASE + path, { method: payload ? 'POST' : 'GET', headers: { 'X-API-Key': env.PIKA_API_KEY, ...(payload ? { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Seedance returned HTTP ${response.status}.`);
      return response.json();
    };
    const job = await step.do(`${key}-submit`, { retries: { limit: 2, delay: '10 seconds' }, timeout: '3 minutes' }, async () => {
      const cached = await store.cachedJson(key);
      if (cached) return cached;
      const created = await request(`/v1/media/${MODEL}`, body);
      if (typeof created.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(created.id)) throw new Error('Seedance returned an invalid job ID.');
      await store.saveCachedJson(key, { id: created.id }); return { id: created.id };
    });
    if (job.asset) return { ...job.asset, cached: true };
    // Generation takes minutes. Frequent polling wastes provider requests and
    // Workflow steps without making the model finish sooner.
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await step.do(`${key}-poll-${attempt}`, () => request(`/v1/media/jobs/${job.id}`));
      if (status.status === 'failed') throw new Error('Seedance video generation failed.');
      if (status.status === 'completed') {
        return step.do(`${key}-download`, { timeout: '8 minutes', retries: { limit: 2, delay: '15 seconds' } }, async () => {
          const content = await request(`/v1/media/jobs/${job.id}/content`);
          let url = new URL(content.url), response;
          for (let n = 0; n < 6; n++) {
            if (url.protocol !== 'https:') throw new Error('Invalid generated media URL.');
            response = await fetch(url, { redirect: 'manual', headers: url.origin === BASE ? { 'X-API-Key': env.PIKA_API_KEY } : {}, signal: AbortSignal.timeout(180_000) });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            await response.body?.cancel();
            const location = response.headers.get('Location');
            if (!location) throw new Error('Generated video download returned an invalid redirect.');
            url = new URL(location, url);
          }
          if (!response.ok) throw new Error('Generated video download failed.');
          const asset = await media.ingestMedia(response.body, 'video/mp4', { kind: 'ai-generated-video', prompt, model: 'Seedance 2.0' });
          await store.saveCachedJson(key, { ...job, asset }); return asset;
        });
      }
      if (!['queued', 'running'].includes(status.status)) throw new Error('Unknown Seedance job state.');
      await step.sleep(`${key}-sleep-${attempt}`, '30 seconds');
    }
    throw new Error('Seedance generation exceeded 15 minutes; its job ID is retained.');
  };
}
