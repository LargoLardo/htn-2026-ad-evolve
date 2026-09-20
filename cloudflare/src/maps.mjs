import { buildMaps } from '../../lib/map-core.mjs';
import { impactResult } from '../../lib/impact-result.mjs';
import { toPixels } from '../../lib/grid.mjs';
import { accountStore } from './storage.mjs';
import { createMedia, callMediaService } from './media.mjs';
import { cloudProviders } from './providers.mjs';
import { scoreQueued } from './neural-queue.mjs';
import { isInterruption } from './interruption.mjs';

export async function mapAsset(env, context, step, prefix, asset, brief, { onProgress = async () => {}, baseline, contractHash } = {}) {
  const media = createMedia(env, context.accountId), store = accountStore(env, context.accountId);
  const providers = cloudProviders(env, context.accountId);
  return buildMaps(asset, brief, { baseline, contractHash, isInterruption, builders: {
    describeElements: original => step.do(`${prefix}-elements`, { retries: { limit: 1, delay: '10 seconds' }, timeout: '4 minutes' }, () => providers.describeElements(original)),
    buildAttentionMap: (original, { grid }) => step.do(`${prefix}-attention`, { retries: { limit: 2, delay: '15 seconds' }, timeout: '7 minutes' }, async () => {
      const result = await callMediaService(env, store, original, 'attention', { grid });
      if (!Array.isArray(result.map) || result.map.length !== grid * grid || result.map.some(v => !Number.isFinite(v)) || typeof result.heatmap !== 'string') throw new Error('Attention service returned an invalid map.');
      await env.MEDIA.put(store.key(`maps/${original.mediaHash}-attention.png`), Buffer.from(result.heatmap, 'base64'), { httpMetadata: { contentType: 'image/png' } });
      const { heatmap, ...attention } = result; return { ...attention, mediaHash: original.mediaHash };
    }),
    async buildImpactMap(original, _brief, { elements, baseline, contractHash }) {
      const first = await scoreQueued(env, context, step, `${prefix}-original`, [{ id: 'occl-original', asset: original }], brief, { baseline, contractHash });
      baseline = first.baseline; let calls = first.calls;
      const measured = [];
      for (const [index, element] of elements.entries()) {
        const cell = { ...element, index, ...toPixels(element, original.width, original.height) };
        const asset = await step.do(`${prefix}-mask-${index}`, () => media.maskCell(original, cell));
        const result = await scoreQueued(env, context, step, `${prefix}-occlude-${index}`, [{ id: `occl-${index}`, asset }], brief, { baseline, contractHash });
        calls += result.calls; measured.push({ cell, asset, neural: result.results[0].neural });
        await step.do(`${prefix}-progress-${index}`, () => onProgress({ done: index + 1, total: elements.length, id: `occl-${index}` }));
      }
      return impactResult(original, baseline, first.results[0].neural, measured, calls);
    },
  } });
}

export async function saveMap(env, accountId, asset, runId, label, result, elapsedMs) {
  const store = accountStore(env, accountId), builtAt = new Date().toISOString();
  const artifact = { mediaHash: asset.mediaHash, width: asset.width, height: asset.height, runId, label, builtAt, elapsedMs, ...result };
  if (artifact.impact?.baseline) { const { statsF64, ...metadata } = artifact.impact.baseline; artifact.impact = { ...artifact.impact, baseline: metadata }; }
  const key = `maps/${asset.mediaHash}.json`;
  await store.putJson(key, artifact);
  await env.INDEX.prepare('INSERT INTO maps(account_id,media_hash,run_id,artifact_key,built_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id,media_hash) DO UPDATE SET run_id=excluded.run_id,artifact_key=excluded.artifact_key,built_at=excluded.built_at')
    .bind(accountId, asset.mediaHash, runId, store.key(key), builtAt).run();
}
