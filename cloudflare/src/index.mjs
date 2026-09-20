import { authenticate, requireSameOrigin, HttpError } from './auth.mjs';
import { createRun, validateBrief, LIMITS } from '../../lib/evolution.mjs';
import { createMedia, serveAsset, MAX_IMAGE_BYTES, MAX_MEDIA_BYTES } from './media.mjs';
import { cloudProviders } from './providers.mjs';
import { accountStore, listRuns, runDocument } from './storage.mjs';
import { consumeNeural } from './neural-queue.mjs';
export { RunDocument } from './run-document.mjs';
export { EvolutionWorkflow, MapWorkflow } from './workflows.mjs';

const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Use Content-Type: application/json.');
  const reader = request.body?.getReader(), chunks = []; let size = 0;
  if (!reader) throw new HttpError(400, 'Provide a JSON body.');
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > LIMITS.maxBodyBytes) { await reader.cancel(); throw new HttpError(413, 'Request body is too large.'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export async function fetchApi(request, env) {
  try {
    requireSameOrigin(request);
    const { accountId } = await authenticate(request, env);
    const url = new URL(request.url), path = url.pathname;
    const media = createMedia(env, accountId), store = accountStore(env, accountId);
    const capabilities = () => ({ ...cloudProviders(env, accountId).capabilities(), liveVideos: Boolean(env.PIKA_API_KEY && env.MEDIA_SERVICE_URL), attentionMaps: Boolean(env.MEDIA_SERVICE_URL), durableRuns: true, limits: { ...LIMITS, maxImageBytes: MAX_IMAGE_BYTES, maxVideoBytes: MAX_MEDIA_BYTES } });
    if (path === '/api/config' && request.method === 'GET') return json(capabilities());
    if (path === '/api/account' && request.method === 'GET') return json({ accountId });
    if (path === '/api/runs' && request.method === 'GET') return json(await listRuns(env, accountId));
    if (path === '/api/media' && request.method === 'POST') {
      const type = request.headers.get('Content-Type')?.split(';')[0];
      const limit = type === 'video/mp4' ? MAX_MEDIA_BYTES : MAX_IMAGE_BYTES;
      if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Media exceeds its upload size limit.');
      if (!request.body) throw new HttpError(400, 'Empty media upload.');
      const asset = await media.ingestMedia(request.body, type);
      return json({ id: asset.mediaHash, asset }, 201);
    }
    if (path === '/api/runs' && request.method === 'POST') {
      let brief, input = await readJson(request);
      try { brief = validateBrief(input); } catch (error) { throw new HttpError(400, error.message); }
      brief.selectionPolicy = input.selectionPolicy || 'auto';
      if (!['auto', 'manual'].includes(brief.selectionPolicy)) throw new HttpError(400, 'Choose automatic or manual parent selection.');
      if (input.feedbackEveryRound !== undefined && typeof input.feedbackEveryRound !== 'boolean') throw new HttpError(400, 'Invalid feedback setting.');
      brief.feedbackEveryRound = input.feedbackEveryRound === true;
      const config = capabilities();
      if (!config.liveResearch || !config.tribe || !(brief.mediaType === 'video' ? config.liveVideos : config.liveImages)) throw new HttpError(503, 'Configure the selected media and scoring providers.');
      if (brief.feedbackEveryRound && (!config.attentionMaps || brief.mediaType !== 'image')) throw new HttpError(400, 'Per-round maps require images and the attention service.');
      if (brief.originalMediaId) {
        brief.originalAsset = await media.getUploadedAsset(brief.originalMediaId);
        if (brief.originalAsset.mediaType !== brief.mediaType) throw new HttpError(400, 'Original media must match the selected ad format.');
      }
      brief.referenceAssets = await Promise.all(brief.referenceMediaIds.map(id => media.getUploadedAsset(id)));
      if (brief.referenceAssets.some(asset => asset.mediaType !== 'image')) throw new HttpError(400, 'Style references must be images.');
      const run = createRun(brief);
      const admitted = await env.INDEX.prepare("INSERT INTO runs(account_id,id,product,status,stage,created_at,metrics_json) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM runs WHERE account_id=? AND status='running') < ?")
        .bind(accountId, run.id, brief.product, run.status, run.stage, run.createdAt, JSON.stringify(run.metrics), accountId, LIMITS.activeRuns).run();
      if (!admitted.meta.changes) throw new HttpError(429, 'Two runs are already active in this account.');
      try { return json(await runDocument(env, accountId, run.id).initialize(accountId, run), 202); }
      catch (error) {
        // An RPC can fail after the DO committed. Preserve its admission slot
        // and return the saved run instead of orphaning an active Workflow.
        const saved = await runDocument(env, accountId, run.id).get();
        if (saved) return json(saved, 202);
        await env.INDEX.prepare('DELETE FROM runs WHERE account_id=? AND id=?').bind(accountId, run.id).run(); throw error;
      }
    }
    const route = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(export|cancel|decision|stream|maps|maps\/stream))?$/.exec(path);
    if (route) {
      const doc = runDocument(env, accountId, route[1]), run = await doc.get();
      if (!run) throw new HttpError(404, 'Run not found.');
      const action = route[2];
      if (request.method === 'GET' && !action) return json(run);
      if (request.method === 'GET' && action === 'export') return json(run, 200, { 'Content-Disposition': `attachment; filename="evolve-${run.id}.json"` });
      if (request.method === 'POST' && action === 'cancel') return json(await doc.cancel());
      if (request.method === 'POST' && action === 'decision') {
        let result; try { result = await doc.decide(await readJson(request)); } catch (error) { throw new HttpError(400, error.message); }
        return json(result, result.error ? result.status : 200);
      }
      if (request.method === 'POST' && action === 'maps') {
        if (run.status === 'running') throw new HttpError(409, 'Wait for the run to finish before building its maps.');
        if (!env.MEDIA_SERVICE_URL) throw new HttpError(503, 'Configure the attention service.');
        return json(await doc.startMaps(), 202);
      }
      if (request.method === 'GET' && action === 'maps') return json(await doc.maps() || { runId: run.id, status: 'idle', targets: [] });
      if (request.method === 'GET' && ['stream', 'maps/stream'].includes(action)) return await doc.fetch(new Request(`https://run/stream?kind=${action === 'stream' ? 'run' : 'maps'}`));
      throw new HttpError(405, 'Method not allowed.');
    }
    if (path === '/api/maps' && request.method === 'GET') {
      const { results } = await env.INDEX.prepare('SELECT media_hash FROM maps WHERE account_id=? ORDER BY built_at DESC LIMIT 200').bind(accountId).all();
      return json(results.map(row => row.media_hash));
    }
    const map = /^\/api\/maps\/([a-f0-9]{64})(\/attention\.png)?$/.exec(path);
    if (map && request.method === 'GET') {
      const object = await env.MEDIA.get(store.key(`maps/${map[1]}${map[2] ? '-attention.png' : '.json'}`));
      if (!object) throw new HttpError(404, 'Map not found.');
      return new Response(object.body, { headers: { 'Content-Type': map[2] ? 'image/png' : 'application/json', 'Cache-Control': 'private, no-cache' } });
    }
    if (path.startsWith('/assets/') && ['GET', 'HEAD'].includes(request.method)) return await serveAsset(request, env, accountId, path.slice(8));
    throw new HttpError(404, 'Route not found.');
  } catch (error) { return json({ error: error.status ? error.message : 'The hosted API could not complete this request.' }, error.status || 500); }
}
export default { fetch: fetchApi, queue: consumeNeural };
