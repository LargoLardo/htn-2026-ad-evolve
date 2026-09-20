import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getScoringContract } from './scoring-contract.mjs';
import { ingestMedia, mediaPayload, reviewMedia } from './media.mjs';
import { renderVideo } from './video-provider.mjs';
import { createProviders } from './provider-core.mjs';
export { validateScreen } from './provider-core.mjs';

const evaluationCache = () => resolve(process.env.EVALUATION_CACHE_DIR || 'data/evaluation-cache');
async function cachedJson(name) {
  try { return JSON.parse(await readFile(resolve(evaluationCache(), `${name}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Evaluation cache is unreadable or corrupt.'); }
}
async function saveCachedJson(name, value) {
  await mkdir(evaluationCache(), { recursive: true });
  const path = resolve(evaluationCache(), `${name}.json`), temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}
const providers = /* @__PURE__ */ createProviders({ env: process.env, getScoringContract,
  ingestMedia, mediaPayload, reviewMedia, renderVideo, cachedJson, saveCachedJson,
  async readMap(hash) {
    try { return JSON.parse(await readFile(resolve(process.env.EVOLVE_MAPS_DIR || 'data/maps', `${hash}-maps.json`), 'utf8')); }
    catch { return null; }
  },
});
export const { capabilities, getNeuralConfig, research, generateConcepts, describeElements, describeReferences, readImpactNotes, renderCandidate, screenCandidate, scoreTribe } = providers;
