// Read a built map artifact and say, in words, what it found.
//
//   node scripts/report-maps.mjs <mediaHash|runId>
//
// The artifact is a few thousand numbers. The demo is one sentence about a
// headline. This is the translation, and it doubles as the check that the
// element labels actually line up with the measured cells.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { impactNotes } from '../lib/grid.mjs';

const dir = process.env.EVOLVE_MAPS_DIR || 'data/maps';
const wanted = process.argv[2];

const names = (await readdir(dir)).filter(name => name.endsWith('-maps.json'));
const artifacts = [];
for (const name of names) {
  const artifact = JSON.parse(await readFile(join(dir, name), 'utf8'));
  if (!wanted || artifact.mediaHash.startsWith(wanted) || artifact.runId === wanted) artifacts.push(artifact);
}
if (!artifacts.length) { console.error(`No map artifacts in ${dir}${wanted ? ` matching ${wanted}` : ''}.`); process.exit(1); }

artifacts.sort((a, b) => String(a.builtAt).localeCompare(String(b.builtAt)));

for (const artifact of artifacts) {
  const { mediaHash, grid, window, label, width, height, elements = [], gap, impact } = artifact;
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${label ?? 'unlabelled'}  ${mediaHash.slice(0, 12)}  ${width}x${height}  grid ${grid}x${grid}` +
    (window ? `  occluder ${window}x${window}` : '') + (impact ? `  ${impact.calls} worker calls` : '  attention only'));

  if (!gap) { console.log(`No impact map: ${artifact.impactError ?? 'unknown reason'}`); continue; }

  // Correlation between predicted gaze and measured impact. Near zero or
  // negative is the interesting case: it means the ad spends attention where
  // it earns nothing, which is the entire argument.
  const a = gap.attention, b = gap.impact;
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const [ma, mb] = [mean(a), mean(b)];
  const cov = a.reduce((sum, value, i) => sum + (value - ma) * (b[i] - mb), 0);
  const sd = values => Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0));
  const r = cov / ((sd(a) * sd(b)) || 1);
  console.log(`\nGaze vs impact correlation: r = ${r >= 0 ? '+' : ''}${r.toFixed(3)}`);
  console.log(r < 0.2
    ? '  The ad is not spending attention where it earns response.'
    : '  Gaze and impact broadly agree on this ad.');

  if (elements.length) {
    console.log('\nBy element, worst first:');
    const pad = Math.max(...elements.map(element => element.label.length));
    for (const element of elements) {
      const value = element.gap ?? 0;
      const verdict = value > 0.15 ? 'looked at, does nothing'
        : value < -0.15 ? 'drives the response'
        : 'agrees';
      console.log(`  ${element.label.padEnd(pad)}  ${value >= 0 ? '+' : ''}${value.toFixed(2)}  ${verdict}`);
    }
    console.log(`\nNote fed to the next generation:\n  ${impactNotes(elements) || '(nothing decisive enough to say)'}`);
  } else {
    console.log('\nNo element labels on this artifact.');
  }
}
console.log();
