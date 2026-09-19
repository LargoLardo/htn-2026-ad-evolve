import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const NEURAL_TARGETS = ['dorsal_attention', 'visual', 'ventral_attention', 'control', 'default', 'limbic', 'somatomotor'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const referencePath = () => resolve(process.env.TRIBE_REFERENCE_PATH || 'data/experimental/oasis60-yeo7-v1.json');
export const hasReference = () => existsSync(referencePath()) && existsSync(referencePath().replace(/\.json$/, '.sha256'));
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function decodeFloats(encoded, dimension) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid feature encoding.');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length !== dimension * 4) throw new Error('Feature dimension mismatch.');
  const values = Array.from({ length: dimension }, (_, i) => raw.readFloatLE(i * 4));
  if (values.some(value => !Number.isFinite(value))) throw new Error('Nonfinite neural features.');
  return values;
}

export function prepareReference(data, digest) {
  if (data.schema !== 'evolve-network-reference-v1' || data.dimension !== 20484 || data.surface !== 'fsaverage5' || data.vertex_order !== 'left-then-right' || data.labels_used !== false || data.reference_count < 10 || !data.contract?.feature_spec_hash || !Array.isArray(data.maps) || data.maps.length !== 7) throw new Error('Invalid experimental neural reference.');
  const mean = decodeFloats(data.mean_f32, data.dimension), scale = decodeFloats(data.scale_f32, data.dimension);
  const labels = Buffer.from(data.network_u8, 'base64');
  if (labels.length !== data.dimension || labels.some(label => label > 7) || scale.some(value => value <= 0) || !Number.isFinite(data.max_reference_rms) || data.max_reference_rms <= 0) throw new Error('Invalid reference normalization.');
  const indices = Array.from(labels.keys()).filter(index => labels[index] > 0);
  if (indices.length < 100 || new Set(data.maps.map(map => map.key)).size !== 7) throw new Error('Invalid cortical mask/maps.');
  const maps = data.maps.map(map => {
    const values = map.reference_correlations;
    if (!NEURAL_TARGETS.includes(map.key) || !Number.isInteger(map.index) || map.index < 1 || map.index > 7 || !Array.isArray(values) || values.length !== data.reference_count || values.some((v, i) => !Number.isFinite(v) || Math.abs(v) > 1 || (i > 0 && v < values[i - 1]))) throw new Error('Invalid reference distribution.');
    const count = indices.reduce((sum, index) => sum + Number(labels[index] === map.index), 0);
    if (!count || count === indices.length) throw new Error('Degenerate network map.');
    return { ...map, count, norm: Math.sqrt(count * (1 - count / indices.length)) };
  });
  return { data, digest, mean, scale, labels, indices, maps };
}

export function loadReference(path = referencePath()) {
  const bytes = readFileSync(path), digest = sha256(bytes);
  if (readFileSync(path.replace(/\.json$/, '.sha256'), 'utf8').trim() !== digest) throw new Error('Frozen neural reference checksum mismatch.');
  return prepareReference(JSON.parse(bytes), digest);
}

export function validateFeatureResult(result, reference, expected) {
  if (!result || result.id !== expected.id || result.media_hash !== expected.media_hash || result.feature_dim !== reference.data.dimension) throw new Error('TRIBE feature identity/media validation failed.');
  for (const [key, value] of Object.entries(reference.data.contract)) {
    if (stable(result.metadata?.[key]) !== stable(value)) throw new Error(`TRIBE reference protocol mismatch: ${key}. The paused 5-second experiment cannot use the 10-second reference.`);
  }
  if (typeof result.pooled_f32_base64 !== 'string' || sha256(Buffer.from(result.pooled_f32_base64, 'base64')) !== result.pooled_sha256) throw new Error('TRIBE feature checksum validation failed.');
  return decodeFloats(result.pooled_f32_base64, reference.data.dimension);
}

export function scorePattern(vector, reference, target = 'dorsal_attention') {
  const { data, mean, scale, labels, indices, maps } = reference;
  if (!NEURAL_TARGETS.includes(target) || vector.length !== data.dimension || Array.from(vector).some(v => !Number.isFinite(v))) throw new Error('Invalid neural target or feature vector.');
  const z = indices.map(i => (vector[i] - mean[i]) / scale[i]);
  const avg = z.reduce((a, b) => a + b, 0) / z.length;
  const rms = Math.sqrt(z.reduce((sum, v) => sum + v * v, 0) / z.length);
  const centered = z.map(v => v - avg), norm = Math.sqrt(centered.reduce((sum, v) => sum + v * v, 0));
  if (norm < 1e-12) throw new Error('Neural pattern is constant; spatial correlation is undefined.');
  const patterns = Object.fromEntries(maps.map(map => {
    const numerator = indices.reduce((sum, index, i) => sum + (labels[index] === map.index ? centered[i] : 0), 0);
    const correlation = Math.max(-1, Math.min(1, numerator / (norm * map.norm)));
    const below = map.reference_correlations.filter(v => v < correlation - 1e-10).length;
    const tied = map.reference_correlations.filter(v => Math.abs(v - correlation) <= 1e-10).length;
    return [map.key, { label: map.label, correlation, percentile: 100 * (below + tied / 2) / data.reference_count }];
  }));
  const outOfReference = rms > Math.max(5, data.max_reference_rms * 3);
  return { source: 'tribe-pattern-experimental', patterns, target, targetPercentile: patterns[target].percentile,
    usableForSelection: !outOfReference, outOfReference, referenceRms: rms,
    referenceVersion: data.version, referenceHash: reference.digest, referenceCount: data.reference_count,
    confidence: null, provenance: 'Frozen TRIBE features + published Yeo network maps; percentiles relative to cached OASIS images. Experimental pattern similarity, not measured attention, emotion, or conversion.' };
}
