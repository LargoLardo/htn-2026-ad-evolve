import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function getScoringContract() {
  const raw = readFileSync(new URL('../worker/percept_spec.json', import.meta.url));
  return { ...JSON.parse(raw), hash: sha256(raw) };
}
export const FAMILY_KEYS = ['auditory_engagement', 'language_message', 'attention_salience', 'visual_motion'];

export function validateBaseline(baseline, contract) {
  const b = baseline;
  if (!b || b.contractHash !== contract.hash || ['mediaHash', 'predictionHash', 'statsSha256', 'hash'].some(key => !/^[a-f0-9]{64}$/.test(b[key])) || !b.runtimeVersions || typeof b.runtimeVersions !== 'object' || Array.isArray(b.runtimeVersions) || !Object.keys(b.runtimeVersions).length || Object.values(b.runtimeVersions).some(v => typeof v !== 'string') || typeof b.statsF64 !== 'string' || b.statsF64.length !== 436992 || !/^[A-Za-z0-9+/]+$/.test(b.statsF64)) throw new Error('Invalid original baseline metadata or statistics.');
  const raw = Buffer.from(b.statsF64, 'base64');
  const metadata = Object.fromEntries(['mediaHash', 'predictionHash', 'contractHash', 'runtimeVersions', 'statsSha256'].map(key => [key, b[key]]));
  if (raw.length !== 2 * 20484 * 8 || sha256(raw) !== b.statsSha256 || sha256(stable(metadata)) !== b.hash) throw new Error('Original baseline checksum mismatch.');
  for (let i = 0; i < 2 * 20484; i++) {
    const value = raw.readDoubleLE(i * 8);
    if (!Number.isFinite(value) || (i >= 20484 && value < 1e-6)) throw new Error('Invalid original baseline statistics.');
  }
  return b;
}

export function validateNeural(result, candidate, baseline, contract) {
  const n = result?.neural;
  if (result?.id !== candidate.id || result.media_hash !== candidate.media_hash || n?.source !== 'tribe-percept' || n.contractHash !== contract.hash || n.baselineHash !== baseline.hash || n.baselineMediaHash !== baseline.mediaHash || !Number.isFinite(n.engagementScore) || n.engagementScore < 0 || n.engagementScore > 100 || !Number.isInteger(n.frames) || n.frames < 1 || n.frames > 120 || n.regions?.length !== 4 || !n.provenance) throw new Error('Invalid Percept score, contract, baseline or media identity.');
  if (new Set(n.regions.map(r => r.key)).size !== 4) throw new Error('Invalid Percept family scores.');
  for (const region of n.regions) {
    if (!FAMILY_KEYS.includes(region.key) || !Number.isFinite(region.score) || region.score < 0 || region.score > 100 || region.values?.length !== n.frames || region.values.some(v => !Number.isFinite(v) || v < 0 || v > 100)) throw new Error('Invalid Percept family scores.');
  }
  // Optional: older cached scores predate per-parcel traces, so absence is fine.
  if (n.parcels !== undefined) {
    if (!Array.isArray(n.parcels) || !n.parcels.length) throw new Error('Invalid Percept parcel traces.');
    for (const parcel of n.parcels) {
      if (!FAMILY_KEYS.includes(parcel.key) || typeof parcel.name !== 'string' || !parcel.name || parcel.values?.length !== n.frames || parcel.values.some(v => !Number.isFinite(v) || v < 0 || v > 100)) throw new Error('Invalid Percept parcel traces.');
    }
  }
  if (n.version !== contract.version || result.metadata?.protocol !== contract.protocol || result.metadata?.percept_revision !== contract.percept_revision || !/^[a-f0-9]{64}$/.test(result.metadata?.prediction_hash) || !Number.isFinite(n.duration) || n.duration <= 0 || n.global?.length !== n.frames || n.global.some(v => !Number.isFinite(v) || v < 0 || v > 100)) throw new Error('Invalid Percept worker protocol or time series.');
  if (stable(result.metadata?.runtime_versions) !== stable(baseline.runtimeVersions)) throw new Error('TRIBE runtime changed from the original baseline.');
  return n;
}
