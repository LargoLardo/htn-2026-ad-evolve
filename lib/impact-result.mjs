import { FAMILY_KEYS } from './scoring-validation.mjs';
const familyScores = neural => Object.fromEntries(neural.regions.map(region => [region.key, region.score]));
export function impactResult(original, baseline, originalNeural, measured, calls) {
  const originalFamilies = familyScores(originalNeural);
  const regions = measured.map(({ cell, asset, neural }) => {
    const families = familyScores(neural);
    return { label: cell.label, kind: cell.kind, index: cell.index, x: cell.fx, y: cell.fy, w: cell.fw, h: cell.fh,
      mediaHash: asset.mediaHash,
      engagementDelta: Number((originalNeural.engagementScore - neural.engagementScore).toFixed(2)),
      familyDeltas: Object.fromEntries(FAMILY_KEYS.map(key => [key, Number(((originalFamilies[key] ?? 0) - (families[key] ?? 0)).toFixed(2))])) };
  }).sort((a, b) => a.index - b.index);
  return { calls, baseline, original: { mediaHash: original.mediaHash, engagementScore: originalNeural.engagementScore, families: originalFamilies }, regions,
    maps: { engagement: regions.map(r => r.engagementDelta), ...Object.fromEntries(FAMILY_KEYS.map(key => [key, regions.map(r => r.familyDeltas[key])])) },
    provenance: 'Occlusion deltas over neural family scores, one pass per detected element of the ad. Predicted, parcel-averaged cortical response, not measured attention.' };
}
