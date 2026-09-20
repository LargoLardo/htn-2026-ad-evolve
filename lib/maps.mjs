import { buildMaps as buildMapsCore } from './map-core.mjs';
import { buildAttentionMap } from './attention-map.mjs';
import { buildImpactMap } from './impact-map.mjs';
import { describeElements } from './providers.mjs';
export { DEFAULT_IMPACT_METRIC } from './map-core.mjs';
export const buildMaps = (asset, brief, options = {}) => buildMapsCore(asset, brief, {
  ...options, builders: { buildAttentionMap, buildImpactMap, describeElements },
});
