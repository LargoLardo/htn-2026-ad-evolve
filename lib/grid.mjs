/**
 * Shared grid geometry for the attention and impact maps.
 *
 * Both maps must reduce to the SAME cells or their difference is meaningless,
 * so the cell rectangles are computed here once and used by both pipelines.
 *
 * Everything in this file is pure: arrays in, arrays out, no fs and no
 * child_process. That keeps it portable to a Worker unchanged when the rest
 * moves to Cloudflare.
 */

export const DEFAULT_GRID = 3;

/**
 * Integer cell rectangles covering the whole image with no gaps or overlap.
 *
 * Rounding is cumulative rather than per-cell (each edge is derived from the
 * exact fraction) so the last row and column reach the far edge exactly; naive
 * `floor(width / n)` leaves an unmasked strip when the size is not divisible.
 */
export function cells(width, height, n = DEFAULT_GRID) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < n || height < n) throw new Error('Image is smaller than the requested grid.');
  if (!Number.isInteger(n) || n < 2 || n > 8) throw new Error('Grid must be an integer from 2 to 8.');
  const edge = (index, total) => Math.round((index * total) / n);
  const out = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = edge(col, width), y = edge(row, height);
      out.push({ row, col, index: row * n + col, x, y, w: edge(col + 1, width) - x, h: edge(row + 1, height) - y });
    }
  }
  return out;
}

/** Mean of a single-channel WxH map over each grid cell. */
export function reduceToGrid(values, width, height, n = DEFAULT_GRID) {
  if (values.length !== width * height) throw new Error('Pixel buffer does not match the stated dimensions.');
  return cells(width, height, n).map(cell => {
    let sum = 0;
    for (let y = cell.y; y < cell.y + cell.h; y++) for (let x = cell.x; x < cell.x + cell.w; x++) sum += values[y * width + x];
    return sum / (cell.w * cell.h);
  });
}

/**
 * Rescale to 0-1 so two maps in different units can be compared.
 *
 * A constant map normalises to all zeros rather than dividing by zero. That is
 * the honest answer: a flat map has no hot region, and it is also the signal
 * that something upstream is saturated.
 */
export function normalize(grid) {
  const min = Math.min(...grid), max = Math.max(...grid);
  return max - min < 1e-12 ? grid.map(() => 0) : grid.map(value => (value - min) / (max - min));
}

/**
 * The pitch, as one function.
 *
 * Positive means people look there and it does not move the response. Negative
 * means it moves the response without drawing the eye. Both maps are normalised
 * first because gaze density and a Percept delta are not the same unit.
 */
export function gap(attention, impact) {
  if (attention.length !== impact.length) throw new Error('Maps must share the same grid.');
  const a = normalize(attention), b = normalize(impact);
  return a.map((value, index) => value - b[index]);
}

/** Cells ranked by how badly attention and impact disagree, worst first. */
export function disagreements(attention, impact, n = DEFAULT_GRID) {
  return gap(attention, impact)
    .map((value, index) => ({ index, row: Math.floor(index / n), col: index % n, gap: value }))
    .sort((left, right) => Math.abs(right.gap) - Math.abs(left.gap));
}
