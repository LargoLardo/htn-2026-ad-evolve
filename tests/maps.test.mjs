import test from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, cells, disagreements, gap, normalize, reduceToGrid, scoreElements, windows } from '../lib/grid.mjs';

test('cells tile the image exactly, including sizes the grid does not divide', () => {
  for (const [width, height, n] of [[1024, 1024, 3], [1000, 777, 3], [999, 1001, 5], [512, 512, 4]]) {
    const region = cells(width, height, n);
    assert.equal(region.length, n * n);
    assert.equal(region.reduce((sum, cell) => sum + cell.w * cell.h, 0), width * height, `${width}x${height}/${n} area`);
    // No pixel covered twice and none missed.
    const covered = new Set();
    for (const cell of region) for (let y = cell.y; y < cell.y + cell.h; y++) for (let x = cell.x; x < cell.x + cell.w; x++) covered.add(y * width + x);
    assert.equal(covered.size, width * height, `${width}x${height}/${n} coverage`);
  }
});

test('reduceToGrid isolates the cell a signal actually sits in', () => {
  const width = 30, height = 30, pixels = new Float64Array(width * height);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) pixels[y * width + x] = 1;
  assert.deepEqual(reduceToGrid(pixels, width, height, 3), [1, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a constant map normalises to zeros rather than dividing by zero', () => {
  assert.deepEqual(normalize([5, 5, 5]), [0, 0, 0]);
});

test('gap separates looked-at-but-inert from unseen-but-driving', () => {
  const attention = [1, 0, 0, 0, 0, 0, 0, 0, 0];
  const impact = [0, 0, 0, 0, 0, 0, 0, 0, 1];
  const difference = gap(attention, impact);
  assert.equal(difference[0], 1, 'cell 0 is looked at and does nothing');
  assert.equal(difference[8], -1, 'cell 8 drives the response unseen');
  const worst = disagreements(attention, impact, 3);
  assert.equal(Math.abs(worst[0].gap), 1);
  assert.ok(Math.abs(worst.at(-1).gap) < 1e-12, 'agreeing cells rank last');
});

test('the two maps must share a grid before they can be differenced', () => {
  assert.throws(() => gap([1, 2, 3], [1, 2]), /same grid/);
});

test('a sliding occluder buys resolution without buying GPU passes', () => {
  const region = windows(800, 800, 8, 3);
  // (8 - 3 + 1)^2 positions, not 8^2: resolution is decoupled from cost.
  assert.equal(region.length, 36);
  for (const w of region) {
    assert.equal(w.covers.length, 9);
    // Each occluder hides a ninth of the ad, not a sixty-fourth, so the Percept
    // delta stays above the run-to-run noise at 8x8.
    assert.ok(w.w * w.h > 800 * 800 * 0.1, 'occluder is large enough to move the score');
  }
  // Every cell is measured by at least one window, or its value is invented.
  const seen = new Set(region.flatMap(w => w.covers));
  assert.equal(seen.size, 64);
});

test('accumulate localises a signal finer than the occluder that measured it', () => {
  const region = windows(800, 800, 8, 3);
  // Only the windows covering cell 27 register a response.
  const deltas = region.map(w => (w.covers.includes(27) ? 1 : 0));
  const map = accumulate(deltas, region, 64);
  const peak = map.indexOf(Math.max(...map));
  assert.equal(peak, 27, 'the peak lands on the responsible cell, not the window centre');
  assert.ok(map[27] > map[26] && map[27] > map[19], 'neighbours are dimmer than the peak');
  assert.equal(map[0], 0, 'a far corner stays cold');
});

test('edge cells are scaled by their real coverage, not the window area', () => {
  const region = windows(300, 300, 3, 2);
  // Every window sees the same response, so every cell must read the same.
  const map = accumulate(region.map(() => 2), region, 9);
  assert.ok(map.every(value => Math.abs(value - 2) < 1e-12), 'corners must not darken');
});

test('an occluder wider than the grid is rejected rather than silently clamped', () => {
  assert.throws(() => windows(300, 300, 3, 4), /Occluder/);
});

test('an element scores from the cells it covers, weighted by overlap', () => {
  // 300x300 on a 3x3 grid: cells are 100x100.
  const impact = [0, 0, 0, 0, 0, 0, 1, 1, 1];  // only the bottom row matters
  const headline = { label: 'headline', x: 0, y: 2 / 3, w: 1, h: 1 / 3 };
  const logo = { label: 'logo', x: 0, y: 0, w: 1 / 3, h: 1 / 3 };
  // Half in the cold middle row, half in the hot bottom row.
  const straddler = { label: 'straddler', x: 0, y: 0.5, w: 1, h: 1 / 3 };

  const [a, b, c] = scoreElements([headline, logo, straddler], { impact }, 300, 300, 3);
  assert.equal(a.impact, 1, 'an element on the hot row takes the hot value');
  assert.equal(b.impact, 0, 'an element away from it stays cold');
  assert.ok(Math.abs(c.impact - 0.5) < 1e-9, 'a straddling element is weighted by area, not by its centre');
  assert.ok(Math.abs(a.coverage - 1 / 3) < 1e-4, 'coverage is the fraction of the ad it occupies');
});
