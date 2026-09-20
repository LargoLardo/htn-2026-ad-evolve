// Precompute both maps for one ad and save the result as a replayable artifact.
//
//   node scripts/build-demo-maps.mjs --image ad.png [--grid 3] [--out data/maps]
//
// The Percept worker is a single L4 replica with concurrency 1, so a 3x3 map is
// roughly twenty minutes of GPU time. That is fine to pay once and unacceptable
// to pay on stage, so the demo reads this file instead of calling the worker.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { ingestMedia } from '../lib/media.mjs';
import { buildMaps } from '../lib/maps.mjs';
import { DEFAULT_GRID } from '../lib/grid.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };

const imagePath = flag('image');
if (!imagePath) { console.error('Usage: node scripts/build-demo-maps.mjs --image <file.png> [--grid 3]'); process.exit(1); }
const grid = Number(flag('grid', String(DEFAULT_GRID)));
const outDir = flag('out', 'data/maps');

const mime = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : /\.webp$/i.test(imagePath) ? 'image/webp' : 'image/png';
const asset = await ingestMedia(await readFile(imagePath), mime, { kind: 'demo-map-input' });
await mkdir(outDir, { recursive: true });

const started = Date.now();
console.log(`${basename(imagePath)}  ${asset.width}x${asset.height}  ${asset.mediaHash.slice(0, 12)}  grid ${grid}x${grid}`);
console.log(`${grid * grid + 1} worker calls at roughly two minutes each; this is the slow part.\n`);

const result = await buildMaps(asset, { product: basename(imagePath), mediaType: 'image' }, {
  grid,
  heatmapPath: join(outDir, `${asset.mediaHash}-attention.png`),
  onProgress: p => console.log(`  [${p.done}/${p.total}] ${p.id}  ${((Date.now() - started) / 1000).toFixed(0)}s`),
});

const path = join(outDir, `${asset.mediaHash}-maps.json`);
await writeFile(path, JSON.stringify({
  mediaHash: asset.mediaHash, width: asset.width, height: asset.height, grid,
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
