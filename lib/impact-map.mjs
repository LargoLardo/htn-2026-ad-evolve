/**
 * Impact map: which regions of an ad actually drive the predicted response.
 *
 * Occlude one grid cell, rescore with Percept, and measure how far the score
 * moved. A large drop means that region was carrying the response.
 *
 * This is deliberately NOT an attention map. Percept's `attention_salience`
 * family is predicted cortical activity in IPS/LIP/FEF and the salience
 * network; the attention map is predicted gaze. Conflating them collapses the
 * whole point, which is the gap between the two.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ffmpeg, ingestMedia, assetsDir } from './media.mjs';
import { scoreTribe } from './providers.mjs';
import { FAMILY_KEYS } from './scoring-contract.mjs';
import { DEFAULT_GRID, DEFAULT_WINDOW, accumulate, cells, windows } from './grid.mjs';

/** Mid grey. Neutral luminance, so occlusion removes content without adding a
 *  bright or dark region that would itself drive a response. */
const MASK_COLOUR = 'gray';

/**
 * Every FFmpeg call in this pipeline lives here.
 *
 * When this moves to Workers, this one function becomes
 * `env.IMAGES.input(bytes).draw(grey, { top, left }).output()` and nothing else
 * in the file changes.
 */
async function maskCell(bytes, cell, { signal } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'evolve-occlusion-'));
  try {
    const source = join(temp, 'source.png'), target = join(temp, 'masked.png');
    await writeFile(source, bytes);
    await ffmpeg(['-loglevel', 'error', '-i', source,
      '-vf', `drawbox=x=${cell.x}:y=${cell.y}:w=${cell.w}:h=${cell.h}:color=${MASK_COLOUR}:t=fill`,
      '-frames:v', '1', '-pix_fmt', 'rgb24', target], { signal });
    return await readFile(target);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

const familyScores = neural => Object.fromEntries(neural.regions.map(region => [region.key, region.score]));
const abortIfCancelled = signal => signal?.throwIfAborted();

/**
 * Score the original plus one occluded variant per cell, then difference them.
 *
 * The unmasked original is scored rather than assumed to be 50. It is only
 * exactly 50 when it is itself the reference, and reading it back costs one
 * pass we would otherwise spend guessing.
 */
export async function buildImpactMap(original, brief, { signal, baseline, contractHash, grid = DEFAULT_GRID, window = DEFAULT_WINDOW, onProgress, concurrency = Number(process.env.PERCEPT_CONCURRENCY) || 1 } = {}) {
  if (original?.mediaType !== 'image') throw new Error('Impact maps are for still images.');
  const size = Math.min(window, grid);
  const region = windows(original.width, original.height, grid, size);
  const cellCount = cells(original.width, original.height, grid).length;
  const bytes = await readFile(join(assetsDir(), original.url.split('/').at(-1)));

  // Masking is local and fast; the GPU calls afterwards are the slow part.
  const masked = [];
  for (const cell of region) {
    const asset = await ingestMedia(await maskCell(bytes, cell, { signal }), 'image/png',
      { signal, kind: 'occlusion-mask', prompt: `Occluded window r${cell.row}c${cell.col} of ${original.mediaHash.slice(0, 8)}` });
    masked.push({ cell, candidate: { id: `occl-r${cell.row}c${cell.col}`, asset } });
  }

  // One image per request, several requests at once.
  //
  // scoreTribe batches four images per call and the worker runs them serially,
  // so a batch of four sits on one connection for eight minutes and the gateway
  // closes it first (measured: died at 5:07). One image per request keeps every
  // call well inside the timeout.
  //
  // Concurrency defaults to 1, and raising it is only safe once replicas are
  // ALREADY up.
  //
  // Each replica has concurrency_target 1, so extra in-flight requests queue
  // rather than parallelise, and Baseten scales reactively over a 60s window.
  // Measured: with max_replica raised to 6 but one replica actually serving,
  // four concurrent requests queued behind ~126s of inference each and the
  // gateway closed them before the new replicas arrived. The whole map failed.
  // Sequential is slower per map but is the only setting that has completed one.
  // Raise PERCEPT_CONCURRENCY only after confirming active_replica > 1.
  const byId = new Map();
  let calls = 0, resolvedBaseline = baseline;
  const scoreOne = async candidate => {
    const scored = await scoreTribe([candidate], brief, { signal, baseline: resolvedBaseline, contractHash });
    calls += scored.calls;
    byId.set(candidate.id, scored.results[0].neural);
    return scored;
  };

  // The original goes first and alone: when no baseline was supplied it is the
  // one that establishes it, and every later cell must be measured against the
  // same reference. Racing it with the cells would give them different ones.
  const first = await scoreOne({ id: 'occl-original', asset: original });
  resolvedBaseline ??= first.baseline;

  let done = 0;
  const queue = [...masked];
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      abortIfCancelled(signal);
      await scoreOne(next.candidate);
      onProgress?.({ done: ++done, total: masked.length, id: next.candidate.id });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, masked.length) }, worker));

  const originalNeural = byId.get('occl-original');
  if (!originalNeural) throw new Error('Percept did not score the unmasked original.');
  const originalFamilies = familyScores(originalNeural);

  const windowResults = masked.map(({ cell, candidate }) => {
    const neural = byId.get(candidate.id);
    if (!neural) throw new Error(`Percept did not score occluded window r${cell.row}c${cell.col}.`);
    const families = familyScores(neural);
    return { row: cell.row, col: cell.col, index: cell.index, covers: cell.covers, mediaHash: candidate.asset.mediaHash,
      engagementDelta: Number((originalNeural.engagementScore - neural.engagementScore).toFixed(2)),
      familyDeltas: Object.fromEntries(FAMILY_KEYS.map(key => [key, Number(((originalFamilies[key] ?? 0) - (families[key] ?? 0)).toFixed(2))])) };
  });

  const ordered = [...windowResults].sort((a, b) => a.index - b.index);
  const round = values => values.map(value => Number(value.toFixed(3)));
  const spread = pick => round(accumulate(ordered.map(pick), region, cellCount));

  return {
    grid, window: size, calls, baseline: resolvedBaseline,
    original: { mediaHash: original.mediaHash, engagementScore: originalNeural.engagementScore, families: originalFamilies },
    // The raw per-occluder measurements, kept alongside the map they produce so
    // a reader can tell a measured cell from an interpolated one.
    windows: ordered,
    // One map per metric, in cell order, so the UI can switch which family it
    // is showing without another GPU pass. All four come back in the same call.
    maps: {
      engagement: spread(cell => cell.engagementDelta),
      ...Object.fromEntries(FAMILY_KEYS.map(key => [key, spread(cell => cell.familyDeltas[key])])),
    },
    provenance: `Occlusion deltas over Percept family scores, measured with a ${size}x${size}-cell occluder stepped one cell at a time over a ${grid}x${grid} grid. Predicted, parcel-averaged cortical response, not measured attention.`,
  };
}
