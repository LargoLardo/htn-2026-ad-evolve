/**
 * The gap view: both maps over the same ad, plus their difference.
 *
 * Two heatmaps are a feature. The difference between them is the argument: an
 * element with high attention and low impact is somewhere people look that
 * does nothing, and one with low attention and high impact is doing the work
 * without drawing the eye.
 *
 * Both maps are reduced to the SAME elements. Attention is a continuous
 * density and impact is one measurement per occluded element, so the shared
 * unit has to be the element, or the difference compares different things.
 */

import { ATTENTION_GRID, gap, normalize, scoreElements } from './grid.mjs';

/** Percept's meaningful family for a silent still image.
 *
 *  auditory_engagement is auditory cortex and visual_motion is the MT+ motion
 *  complex, so both sit near parity on a static, soundless ad. Leading with
 *  either would show a flat map and look broken. */
export const DEFAULT_IMPACT_METRIC = 'attention_salience';

export async function buildMaps(asset, brief, {
  signal, baseline, contractHash, heatmapPath, builders, isInterruption = () => false,
  impactMetric = DEFAULT_IMPACT_METRIC, onProgress,
} = {}) {
  const { describeElements, buildAttentionMap, buildImpactMap } = builders;
  // Elements first: they are now the unit both maps reduce to, not a legend
  // applied afterwards, so nothing else can start without them.
  const elements = await describeElements(asset, { signal });
  if (!elements.length) throw new Error('No elements were detected in this image, so there is nothing to occlude.');

  // Attention needs no GPU, so when Percept is down there is still half a map
  // rather than none. The grid here is only a sampling resolution for a
  // continuous density, not a unit of measurement: it costs nothing, so it can
  // be fine enough that element boxes land on it cleanly.
  const attention = await buildAttentionMap(asset, { signal, grid: ATTENTION_GRID, heatmapPath });

  let impact = null, error = null;
  try {
    impact = await buildImpactMap(asset, brief, { signal, baseline, contractHash, elements, onProgress });
  } catch (caught) {
    if (isInterruption(caught)) throw caught;
    signal?.throwIfAborted();
    error = caught.message;
  }

  // Mean predicted gaze inside each element's own box.
  const gazePerElement = scoreElements(elements, { attention: attention.map }, asset.width, asset.height, ATTENTION_GRID)
    .map(element => element.attention ?? 0);

  if (!impact) {
    return {
      attention, impact: null, impactError: error, gap: null,
      elements: elements.map((element, index) => ({ ...element, order: index, attention: gazePerElement[index], impact: null, gap: null })),
    };
  }

  const impactPerElement = impact.maps[impactMetric] ?? impact.maps.engagement;
  // Both normalised first: gaze density and a Percept delta are not the same
  // unit, so their raw difference would be meaningless.
  const gaze = normalize(gazePerElement), drive = normalize(impactPerElement);
  const difference = gap(gazePerElement, impactPerElement);

  return {
    attention,
    impact,
    impactMetric,
    // Every element carries its own measured gaze, measured impact and the gap
    // between them, worst first. This list is the demo's talking point and it
    // is also what gets fed back into the next round's prompt.
    elements: elements
      .map((element, index) => ({
        ...element,
        // Detection order, kept because this list gets sorted by gap while
        // impact.maps stays in detection order. Without it the UI cannot line
        // an element up with its own per-family score.
        order: index,
        attention: Number(gaze[index].toFixed(3)),
        impact: Number(drive[index].toFixed(3)),
        gap: Number(difference[index].toFixed(3)),
      }))
      .sort((a, b) => b.gap - a.gap),
    gap: { metric: impactMetric, attention: gaze, impact: drive, difference },
  };
}
