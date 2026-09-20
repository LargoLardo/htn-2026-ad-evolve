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

/**
 * Sampling resolution for the attention density.
 *
 * This is no longer a unit of measurement. Impact is measured per detected
 * element, so the grid only exists to reduce a continuous 1024px gaze density
 * to something an element box can be averaged over. It costs no GPU, so it is
 * fine rather than coarse: at 16 a box lands on enough cells that its mean is
 * not dominated by where the grid lines happened to fall.
 */
export const ATTENTION_GRID = 16;

/** Kept for callers that still reduce to a plain grid. */
export const DEFAULT_GRID = 8;

export const MAX_GRID = 16;

/**
 * Integer cell rectangles covering the whole image with no gaps or overlap.
 *
 * Rounding is cumulative rather than per-cell (each edge is derived from the
 * exact fraction) so the last row and column reach the far edge exactly; naive
 * `floor(width / n)` leaves an unmasked strip when the size is not divisible.
 */
export function cells(width, height, n = DEFAULT_GRID) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < n || height < n) throw new Error('Image is smaller than the requested grid.');
  if (!Number.isInteger(n) || n < 2 || n > MAX_GRID) throw new Error(`Grid must be an integer from 2 to ${MAX_GRID}.`);
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


/**
 * A fractional element box as an integer pixel rectangle.
 *
 * Boxes arrive as fractions so they survive rescaling, but FFmpeg draws in
 * pixels. Clamped to the image because a box that starts inside and runs over
 * the edge is common and harmless, while a drawbox past the edge is an error.
 * The fractions are carried through as fx/fy/fw/fh so the artifact can be
 * rendered over an image of any display size.
 */
export function toPixels(box, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(box.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(box.y * height)));
  return {
    x, y,
    w: Math.max(1, Math.min(width - x, Math.round(box.w * width))),
    h: Math.max(1, Math.min(height - y, Math.round(box.h * height))),
    fx: box.x, fy: box.y, fw: box.w, fh: box.h,
  };
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

/**
 * Score named elements against a cell map, with no extra measurements.
 *
 * Each element's value is the area-weighted mean of the cells it covers, so a
 * headline spanning two and a half cells counts the half cell as half. This is
 * what turns "cell r6c2 is cold" into "the headline is dead weight", which is
 * the only form of the result anybody can act on.
 *
 * Weighting by overlap rather than by cell centres matters for ad layouts:
 * headlines are wide and short, and a centre test either claims a whole row or
 * misses the element entirely depending on where the grid lines happen to fall.
 */
export function scoreElements(elements, maps, width, height, n = DEFAULT_GRID) {
  const region = cells(width, height, n);
  return elements.map(element => {
    const box = { x: element.x * width, y: element.y * height, w: element.w * width, h: element.h * height };
    let total = 0;
    const weights = region.map(cell => {
      const overlapX = Math.max(0, Math.min(cell.x + cell.w, box.x + box.w) - Math.max(cell.x, box.x));
      const overlapY = Math.max(0, Math.min(cell.y + cell.h, box.y + box.h) - Math.max(cell.y, box.y));
      const area = overlapX * overlapY;
      total += area;
      return area;
    });
    const mean = values => {
      if (!values || !total) return null;
      let sum = 0;
      weights.forEach((weight, index) => { sum += weight * (values[index] ?? 0); });
      return Number((sum / total).toFixed(3));
    };
    return { ...element, coverage: Number((total / (width * height)).toFixed(4)),
      ...Object.fromEntries(Object.entries(maps).map(([key, values]) => [key, mean(values)])) };
  });
}

/**
 * Turn a measured map into a note the generator can act on.
 *
 * This is the point of measuring impact at all. A heatmap that only ever gets
 * looked at is a diagnosis nobody treats, so the ranked elements become an
 * instruction: keep what carries the response, stop repeating what does not.
 *
 * Deliberately says what to achieve, not what to draw. "Do not repeat a
 * treatment that drew the eye without moving the response" leaves the model
 * free to solve it; naming a replacement would make every child converge on
 * the same fix, which is the opposite of what a population is for.
 */
export function impactNotes(elements, { limit = 3 } = {}) {
  const measured = (elements ?? []).filter(element => Number.isFinite(element.gap));
  if (measured.length < 2) return '';
  const ranked = [...measured].sort((a, b) => b.gap - a.gap);
  const dead = ranked.filter(element => element.gap > 0.15).slice(0, limit);
  const working = ranked.filter(element => element.gap < -0.15).slice(-limit).reverse();
  if (!dead.length && !working.length) return '';

  // Terse and directive, because this text is a prompt, not a report. The
  // earlier phrasing ("these drew the eye without moving the predicted
  // response, so do not reproduce their treatment") buried two instructions
  // inside a clause about methodology, which is exactly the register a model
  // paraphrases instead of obeying.
  const names = list => list.map(element => element.label).join('; ');
  const parts = [];
  if (dead.length) parts.push(`Dead weight in the original, do not repeat: ${names(dead)}.`);
  if (working.length) parts.push(`Carried the original, keep doing this: ${names(working)}.`);
  return parts.join(' ');
}
