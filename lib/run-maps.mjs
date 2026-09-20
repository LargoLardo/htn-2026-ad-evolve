/**
 * Maps as part of a run, rather than a script pointed at a loose file.
 *
 * The maps only mean something next to the ad they came from: the whole claim
 * is "here is what was dead in the original, and here is what the evolution
 * did about it". Building them with a CLI keyed by media hash made them look
 * like a separate analysis tool, which is exactly the wrong idea.
 *
 * A build is long (one GPU pass per occluder position), so this runs detached
 * and reports progress. Progress is per target and per pass, because "72%" is
 * a worse thing to watch than the map filling in.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildMaps } from './maps.mjs';
import { DEFAULT_GRID } from './grid.mjs';

const mapsDir = () => process.env.EVOLVE_MAPS_DIR || 'data/maps';

/** One job per run. A second request for a running job returns the job rather
 *  than starting a duplicate, since two builds would fight over the same GPU
 *  and write the same files. */
const jobs = new Map();
const listeners = new Map();

export const getRunMaps = runId => jobs.get(runId) ?? null;

export function watchRunMaps(runId, listener) {
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId).add(listener);
  return () => listeners.get(runId)?.delete(listener);
}

function publish(job) {
  job.updatedAt = new Date().toISOString();
  for (const listener of listeners.get(job.runId) ?? []) {
    try { listener(job); } catch { /* a broken client must not stop the build */ }
  }
}

/**
 * The two images worth mapping, and only those.
 *
 * The uploaded original is the thing being fixed and the winner is the fix, so
 * the pair is the argument. Mapping every candidate would be eight times the
 * GPU for seven images nobody compares.
 */
export function mapTargets(run) {
  const out = [];
  const add = (asset, label) => {
    if (asset?.mediaType === 'image' && asset.mediaHash && !out.some(t => t.mediaHash === asset.mediaHash)) {
      out.push({ mediaHash: asset.mediaHash, label, asset });
    }
  };
  add(run.brief?.originalAsset, 'Original');
  const ranked = [...run.finalists].sort((a, b) => (b.scores?.neural?.engagementScore ?? 0) - (a.scores?.neural?.engagementScore ?? 0));
  add(ranked[0]?.asset, 'Winner');
  return out;
}

export function startRunMaps(run, { grid = DEFAULT_GRID, window, signal } = {}) {
  const existing = jobs.get(run.id);
  if (existing && existing.status === 'running') return existing;

  const targets = mapTargets(run);
  const job = {
    runId: run.id, status: targets.length ? 'running' : 'empty', grid,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null,
    targets: targets.map(target => ({ mediaHash: target.mediaHash, label: target.label, status: 'queued', done: 0, total: 0, cells: null })),
  };
  jobs.set(run.id, job);
  if (!targets.length) return job;

  (async () => {
    await mkdir(mapsDir(), { recursive: true });
    for (const [index, target] of targets.entries()) {
      const entry = job.targets[index];
      entry.status = 'running';
      publish(job);
      try {
        const started = Date.now();
        const result = await buildMaps(target.asset, run.brief, {
          signal, grid, window,
          heatmapPath: join(mapsDir(), `${target.mediaHash}-attention.png`),
          onProgress: progress => {
            entry.done = progress.done;
            entry.total = progress.total;
            publish(job);
          },
        });
        await writeFile(join(mapsDir(), `${target.mediaHash}-maps.json`), JSON.stringify({
          mediaHash: target.mediaHash, width: target.asset.width, height: target.asset.height,
          runId: run.id, label: target.label, grid,
          builtAt: new Date().toISOString(), elapsedMs: Date.now() - started,
          ...result,
        }, null, 2));
        entry.status = result.impact ? 'done' : 'attention-only';
        entry.error = result.impactError ?? null;
      } catch (caught) {
        entry.status = 'failed';
        entry.error = caught.message;
      }
      publish(job);
    }
    // One target failing still leaves the other worth showing, so the job is
    // only a failure when nothing was produced at all.
    job.status = job.targets.some(target => target.status === 'done' || target.status === 'attention-only') ? 'complete' : 'failed';
    publish(job);
  })();

  return job;
}
