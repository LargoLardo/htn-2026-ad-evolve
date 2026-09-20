import test from 'node:test';
import assert from 'node:assert/strict';
import { cells, disagreements, gap, impactNotes, normalize, reduceToGrid, scoreElements, toPixels } from '../lib/grid.mjs';

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

test('impact notes name what to stop repeating and what to keep', () => {
  const note = impactNotes([
    { label: 'headline', gap: 0.74 },
    { label: 'crowd photo', gap: 0.69 },
    { label: 'clinking glasses', gap: -0.4 },
    { label: 'disco ball', gap: 0.05 },
  ]);
  assert.match(note, /headline/);
  assert.match(note, /clinking glasses/);
  // A cell that agrees is not evidence of anything, so it must not be named.
  assert.doesNotMatch(note, /disco ball/, 'elements where the two maps agree carry no instruction');
  // Silence when there is nothing measured to say, rather than an empty preamble.
  assert.equal(impactNotes([{ label: 'only one', gap: 0.9 }]), '');
  assert.equal(impactNotes([{ label: 'a', gap: 0.01 }, { label: 'b', gap: -0.02 }]), '');
});

test('a fractional box becomes a pixel rect that stays inside the image', () => {
  const box = toPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1024, 1318);
  assert.deepEqual([box.x, box.y, box.w, box.h], [256, 659, 512, 330]);
  // A box that starts inside and runs past the edge is common and harmless.
  // Drawing past the edge is not, so it is clamped rather than rejected.
  const over = toPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100);
  assert.ok(over.x + over.w <= 100 && over.y + over.h <= 100, 'stays within the image');
  // The fractions survive so the artifact can be drawn at any display size.
  assert.equal(box.fw, 0.5);
});
