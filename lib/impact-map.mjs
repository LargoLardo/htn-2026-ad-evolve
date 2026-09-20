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
import { DEFAULT_GRID, cells } from './grid.mjs';

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
export async function buildImpactMap(original, brief, { signal, baseline, contractHash, grid = DEFAULT_GRID, onProgress } = {}) {
  if (original?.mediaType !== 'image') throw new Error('Impact maps are for still images.');
  const region = cells(original.width, original.height, grid);
  const bytes = await readFile(join(assetsDir(), original.url.split('/').at(-1)));

  // Masking is local and fast; the GPU calls afterwards are the slow part.
  const masked = [];
  for (const cell of region) {
    const asset = await ingestMedia(await maskCell(bytes, cell, { signal }), 'image/png',
      { signal, kind: 'occlusion-mask', prompt: `Occluded cell r${cell.row}c${cell.col} of ${original.mediaHash.slice(0, 8)}` });
    masked.push({ cell, candidate: { id: `occl-r${cell.row}c${cell.col}`, asset } });
  }

  // One image per request, deliberately.
  //
  // scoreTribe batches four images per call, and the worker runs them serially.
  // On the L4 trial deployment a single image takes about two minutes, so a
  // batch of four sits on the connection for eight and the gateway closes it
  // first. Sending them one at a time keeps every request well inside the
  // timeout, makes partial progress survivable, and lets a re-run reuse the
  // cache for cells that already succeeded.
  const byId = new Map();
  let calls = 0, resolvedBaseline = baseline;
  const scoreOne = async candidate => {
    const scored = await scoreTribe([candidate], brief, { signal, baseline: resolvedBaseline, contractHash });
    calls += scored.calls;
    // The first scored image establishes the baseline when none was supplied,
    // so every later cell is measured against the same reference.
    resolvedBaseline ??= scored.baseline;
    byId.set(candidate.id, scored.results[0].neural);
  };

  await scoreOne({ id: 'occl-original', asset: original });
  for (const { candidate } of masked) {
    abortIfCancelled(signal);
    await scoreOne(candidate);
    onProgress?.({ done: byId.size - 1, total: masked.length, id: candidate.id });
  }

  const originalNeural = byId.get('occl-original');
  if (!originalNeural) throw new Error('Percept did not score the unmasked original.');
  const originalFamilies = familyScores(originalNeural);

  const cellResults = masked.map(({ cell, candidate }) => {
    const neural = byId.get(candidate.id);
    if (!neural) throw new Error(`Percept did not score occluded cell r${cell.row}c${cell.col}.`);
    const families = familyScores(neural);
    return { row: cell.row, col: cell.col, index: cell.index, mediaHash: candidate.asset.mediaHash,
      engagementDelta: Number((originalNeural.engagementScore - neural.engagementScore).toFixed(2)),
      familyDeltas: Object.fromEntries(FAMILY_KEYS.map(key => [key, Number(((originalFamilies[key] ?? 0) - (families[key] ?? 0)).toFixed(2))])) };
  });

  const ordered = [...cellResults].sort((a, b) => a.index - b.index);
  return {
    grid, calls, baseline: resolvedBaseline,
    original: { mediaHash: original.mediaHash, engagementScore: originalNeural.engagementScore, families: originalFamilies },
    cells: ordered,
    // One map per metric, in cell order, so the UI can switch which family it
    // is showing without another GPU pass. All four come back in the same call.
    maps: {
      engagement: ordered.map(cell => cell.engagementDelta),
      ...Object.fromEntries(FAMILY_KEYS.map(key => [key, ordered.map(cell => cell.familyDeltas[key])])),
    },
    provenance: 'Occlusion deltas over Percept family scores. Predicted, parcel-averaged cortical response, not measured attention.',
  };
}
