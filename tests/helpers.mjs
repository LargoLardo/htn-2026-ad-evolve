import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAMILY_KEYS, getScoringContract, sha256, stable } from '../lib/scoring-contract.mjs';
import { ingestMedia } from '../lib/media.mjs';

export async function isolatedConfig(t, values = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'evolve-test-'));
  const old = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: 'test-secret', PIKA_API_KEY: 'test-pika-secret',
    TRIBE_SCORE_URL: 'http://127.0.0.1:8091/score', EVALUATION_CACHE_DIR: join(dir, 'cache'), EVOLVE_ASSETS_DIR: join(dir, 'assets'), ...values });
  t.after(async () => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
export const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
export async function candidate(id = 'one', file = 'red.png') {
  return { id, asset: await ingestMedia(await fixture(file), file.endsWith('.mp4') ? 'video/mp4' : 'image/png') };
}
export const contract = getScoringContract();
export const runtime = { numpy: 'test', torch: 'test' };
export function baselineFor(mediaHash) {
  const raw = Buffer.alloc(2 * 20484 * 8);
  for (let i = 20484; i < 2 * 20484; i++) raw.writeDoubleLE(1, i * 8);
  const metadata = { mediaHash, predictionHash: sha256('prediction'), contractHash: contract.hash, runtimeVersions: runtime, statsSha256: sha256(raw) };
  return { ...metadata, hash: sha256(stable(metadata)), statsF64: raw.toString('base64') };
}
export function scoreResponse(body) {
  const baseline = body.baseline || baselineFor(body.candidates[0].media_hash);
  return { contract_hash: contract.hash, baseline, results: body.candidates.map(c => ({ id: c.id, media_hash: c.media_hash,
    neural: { source: 'tribe-percept', version: contract.version, contractHash: contract.hash,
      baselineHash: baseline.hash, baselineMediaHash: baseline.mediaHash, engagementScore: 50, frames: 2, duration: 2,
      regions: FAMILY_KEYS.map(key => ({ key, name: key, score: 50, values: [45, 55] })), global: [45, 55], provenance: 'TEST ONLY' },
    metadata: { runtime_versions: runtime, protocol: contract.protocol, percept_revision: contract.percept_revision, prediction_hash: sha256('prediction'), cached: false },
  })) };
}
export const openaiResponse = (parsed, extra = []) => ({ status: 'completed', output: [...extra, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(parsed), annotations: [] }] }] });
