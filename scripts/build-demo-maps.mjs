// Precompute both maps for one ad and save the result as a replayable artifact.
//
//   node scripts/build-demo-maps.mjs --image ad.png [--grid 8] [--window 3] [--out data/maps]
//
// Cost is (grid - window + 1)^2 + 1 worker calls, NOT grid^2: the occluder
// slides one cell at a time, so resolution is nearly free and only the occluder
// size drives the call count. Measured at roughly 26s per call on one L4
// replica at concurrency 1, so an 8x8 map with a 3-cell occluder is 37 calls,
// about sixteen minutes. That is fine to pay once and unacceptable to pay on
// stage, so the demo reads this file instead of calling the worker.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getUploadedAsset, ingestMedia } from '../lib/media.mjs';
import { buildMaps } from '../lib/maps.mjs';
import { DEFAULT_GRID, DEFAULT_WINDOW } from '../lib/grid.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };

const imagePath = flag('image');
if (!imagePath) { console.error('Usage: node scripts/build-demo-maps.mjs --image <file.png> [--grid 8] [--window 3]'); process.exit(1); }
const grid = Number(flag('grid', String(DEFAULT_GRID)));
const window = Number(flag('window', String(DEFAULT_WINDOW)));
const outDir = flag('out', 'data/maps');

// Reuse the asset if this file is already one, rather than re-ingesting it.
//
// ingestMedia re-encodes to rgb24, which changes the bytes and therefore the
// content hash. Re-ingesting an existing asset would key the maps to a hash no
// run candidate has, and the UI would never find them.
const existing = imagePath.match(/([a-f0-9]{64})\.(png|jpe?g|webp)$/i)?.[1];
let asset;
if (existing) {
  asset = await getUploadedAsset(existing).catch(() => null);
}
if (!asset) {
  const mime = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : /\.webp$/i.test(imagePath) ? 'image/webp' : 'image/png';
  asset = await ingestMedia(await readFile(imagePath), mime, { kind: 'demo-map-input' });
}
await mkdir(outDir, { recursive: true });

const started = Date.now();
const passes = (grid - Math.min(window, grid) + 1) ** 2;
console.log(`${basename(imagePath)}  ${asset.width}x${asset.height}  ${asset.mediaHash.slice(0, 12)}  grid ${grid}x${grid}  occluder ${window}x${window} cells`);
console.log(`${passes + 1} worker calls at roughly 26s each (~${Math.round((passes + 1) * 26 / 60)} min); this is the slow part.\n`);

const result = await buildMaps(asset, { product: basename(imagePath), mediaType: 'image' }, {
  grid, window,
  heatmapPath: join(outDir, `${asset.mediaHash}-attention.png`),
  onProgress: p => console.log(`  [${p.done}/${p.total}] ${p.id}  ${((Date.now() - started) / 1000).toFixed(0)}s`),
});

const path = join(outDir, `${asset.mediaHash}-maps.json`);
await writeFile(path, JSON.stringify({
  mediaHash: asset.mediaHash, width: asset.width, height: asset.height, grid, window,
  builtAt: new Date().toISOString(), elapsedMs: Date.now() - started,
  ...result,
}, null, 2));

console.log(`\nSaved ${path}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
if (result.gap) {
  const worst = result.gap.ranked[0];
  console.log(`Widest gap: r${worst.row}c${worst.col}  ${worst.gap >= 0 ? '+' : ''}${worst.gap.toFixed(2)}  ` +
    (worst.gap > 0 ? 'looked at, does nothing' : 'drives the response, unseen'));
} else {
  console.log(`Impact map unavailable: ${result.impactError}`);
}
