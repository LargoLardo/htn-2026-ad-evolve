// Run the attention and impact maps over one image and print the gap.
//
//   node scripts/maps.mjs --image path/to/ad.png [--grid 3] [--attention-only]
//
// The attention map needs no GPU, so --attention-only works while the TRIBE
// worker is cold or unconfigured.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { ingestMedia } from '../lib/media.mjs';
import { buildAttentionMap } from '../lib/attention-map.mjs';
import { buildMaps } from '../lib/maps.mjs';
import { DEFAULT_GRID, normalize } from '../lib/grid.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1]; };
const has = name => args.includes(`--${name}`);

const imagePath = flag('image');
if (!imagePath) { console.error('Usage: node scripts/maps.mjs --image <file.png> [--grid 3] [--attention-only]'); process.exit(1); }
const grid = Number(flag('grid') ?? DEFAULT_GRID);

/** A grid of numbers is unreadable as JSON; print it as the square it is. */
function square(values, n, { width = 7, digits = 2 } = {}) {
  const lines = [];
  for (let row = 0; row < n; row++) {
    lines.push('   ' + values.slice(row * n, row * n + n).map(v => v.toFixed(digits).padStart(width)).join(''));
  }
  return lines.join('\n');
}

const mime = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg'
  : imagePath.endsWith('.webp') ? 'image/webp' : 'image/png';
const asset = await ingestMedia(await readFile(imagePath), mime, { kind: 'map-input' });
console.log(`\n${basename(imagePath)}  ${asset.width}x${asset.height}  ${asset.mediaHash.slice(0, 12)}  grid ${grid}x${grid}\n`);

const heatmap = flag('heatmap');
if (has('attention-only')) {
  const attention = await buildAttentionMap(asset, { grid, heatmapPath: heatmap });
  console.log(`ATTENTION  (${attention.source}, ${attention.device}, centerbias ${attention.centerbias})`);
  console.log(square(normalize(attention.map), grid));
  console.log(`\n${attention.provenance}\n`);
  process.exit(0);
}

// A brief is required only so TRIBE can carry the run's context; the maps
// themselves do not read it.
const brief = { product: 'Map probe', description: basename(imagePath), mediaType: 'image' };
const result = await buildMaps(asset, brief, { grid, heatmapPath: heatmap });

console.log(`ATTENTION  predicted gaze (${result.attention.source})`);
console.log(square(normalize(result.attention.map), grid));

if (!result.impact) {
  console.log(`\nIMPACT     unavailable: ${result.impactError}`);
  console.log('\nThe attention map stands alone. The gap needs TRIBE.\n');
  process.exit(0);
}

console.log(`\nIMPACT     occlusion delta on ${result.impactMetric}  (${result.impact.calls} worker calls)`);
console.log(square(normalize(result.gap.impact), grid));

console.log('\nGAP        attention minus impact, both normalised');
console.log(square(result.gap.difference, grid));

console.log('\nWorst disagreements:');
for (const cell of result.gap.ranked.slice(0, 3)) {
  const sense = cell.gap > 0 ? 'looked at, does nothing' : 'drives the response, unseen';
  console.log(`   r${cell.row}c${cell.col}  ${cell.gap >= 0 ? '+' : ''}${cell.gap.toFixed(2)}  ${sense}`);
}
console.log(`\n${result.impact.provenance}\n`);
