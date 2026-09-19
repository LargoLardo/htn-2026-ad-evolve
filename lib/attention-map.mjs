/**
 * Attention map: predicted eye gaze over a still ad.
 *
 * Thin Node wrapper around maps/saliency.py, which runs DeepGaze IIE. The model
 * is PyTorch, so it stays in Python rather than being reimplemented; this file
 * is the only place that knows a subprocess is involved.
 *
 * When this moves to Workers, this function becomes a fetch to the same script
 * running on Baseten beside TRIBE, or to an ONNX export. The JSON contract it
 * returns does not change.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { assetsDir } from './media.mjs';
import { DEFAULT_GRID } from './grid.mjs';

const exec = promisify(execFile);

/** The maps venv is separate from the app: torch and DeepGaze are a multi-GB
 *  dependency that the Node server has no business carrying. */
export const pythonBin = () => process.env.MAPS_PYTHON || resolve('.venv-maps/bin/python');

export async function attentionAvailable() {
  return existsSync(pythonBin()) && existsSync(resolve('maps/saliency.py'));
}

export async function buildAttentionMap(asset, { signal, grid = DEFAULT_GRID, heatmapPath } = {}) {
  if (asset?.mediaType !== 'image') throw new Error('Attention maps are for still images.');
  if (!(await attentionAvailable())) throw new Error('The maps Python environment is missing. Create .venv-maps and install DeepGaze.');

  const image = join(assetsDir(), asset.url.split('/').at(-1));
  const args = ['maps/saliency.py', '--image', image, '--grid', String(grid)];
  if (heatmapPath) args.push('--heatmap', heatmapPath);

  let stdout;
  try {
    // DeepGaze downloads ~1 GB of weights on first use, so the first call is
    // slow in a way later ones are not.
    ({ stdout } = await exec(pythonBin(), args, { signal, timeout: 600_000, maxBuffer: 8_000_000 }));
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new Error('The maps Python interpreter was not found. Set MAPS_PYTHON.');
    throw new Error(`Attention map failed: ${String(error.stderr || error.message).trim().split('\n').at(-1)}`);
  }

  const result = JSON.parse(stdout);
  if (!Array.isArray(result.map) || result.map.length !== grid * grid || result.map.some(value => !Number.isFinite(value))) {
    throw new Error('Attention map returned an invalid grid.');
  }
  return { ...result, mediaHash: asset.mediaHash };
}
