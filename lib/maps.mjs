/**
 * The gap view: both maps over the same ad, plus their difference.
 *
 * Two heatmaps are a feature. The difference between them is the argument:
 * a cell with high attention and low impact is somewhere people look that does
 * nothing, and a cell with low attention and high impact is doing the work
 * without drawing the eye.
 */

import { DEFAULT_GRID, DEFAULT_WINDOW, disagreements, gap, normalize, scoreElements } from './grid.mjs';
import { buildAttentionMap } from './attention-map.mjs';
import { buildImpactMap } from './impact-map.mjs';
import { describeElements } from './providers.mjs';

/** Percept's meaningful family for a silent still image.
 *
 *  auditory_engagement is auditory cortex and visual_motion is the MT+ motion
 *  complex, so both sit near parity on a static, soundless ad. Leading with
 *  either would show a flat map and look broken. */
export const DEFAULT_IMPACT_METRIC = 'attention_salience';

export async function buildMaps(asset, brief, {
  signal, baseline, contractHash, grid = DEFAULT_GRID, window = DEFAULT_WINDOW,
  heatmapPath, impactMetric = DEFAULT_IMPACT_METRIC, onProgress,
} = {}) {
  // Attention first and on its own: it needs no GPU, so when Percept is down or
  // slow there is still half a demo rather than none.
  const attention = await buildAttentionMap(asset, { signal, grid, heatmapPath });

  // Labels are a legend for the cells, not a measurement, so a failure here
  // costs annotation and nothing else. Never let it take the maps down.
  let elements = [];
  try {
    elements = await describeElements(asset, { signal });
  } catch (caught) {
    signal?.throwIfAborted();
  }

  let impact = null, error = null;
  try {
    impact = await buildImpactMap(asset, brief, { signal, baseline, contractHash, grid, window, onProgress });
  } catch (caught) {
    signal?.throwIfAborted();
    error = caught.message;
  }

  if (!impact) return { grid, window, attention, elements, impact: null, impactError: error, gap: null };

  const impactGrid = impact.maps[impactMetric] ?? impact.maps.engagement;
  return {
    grid,
    window: impact.window,
    attention,
    // Elements carry their own attention, impact and gap numbers, so the UI can
    // say which named part of the ad is dead weight without a second pass.
    elements: scoreElements(elements, {
      attention: normalize(attention.map),
      impact: normalize(impactGrid),
      gap: gap(attention.map, impactGrid),
    }, asset.width, asset.height, grid).sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0)),
    impact,
    impactMetric,
    gap: {
      metric: impactMetric,
      // Both normalised first: gaze density and a Percept delta are not the
      // same unit, so the raw difference would be meaningless.
      attention: normalize(attention.map),
      impact: normalize(impactGrid),
      difference: gap(attention.map, impactGrid),
      // Positive gap: looked at, does nothing. Negative: moves the response
      // without being looked at. This list is the demo's talking point.
      ranked: disagreements(attention.map, impactGrid, grid),
    },
  };
}
