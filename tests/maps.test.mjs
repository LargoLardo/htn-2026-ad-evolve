import test from 'node:test';
import assert from 'node:assert/strict';
import { cells, disagreements, gap, normalize, reduceToGrid } from '../lib/grid.mjs';

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
