import { sha256 } from '../lib/neural-scorer.mjs';
export const floatBytes = values => { const bytes = Buffer.alloc(values.length * 4); values.forEach((v, i) => bytes.writeFloatLE(v, i * 4)); return bytes; };
export function referenceFixture() {
  const keys = ['visual', 'somatomotor', 'dorsal_attention', 'ventral_attention', 'limbic', 'control', 'default'];
  const n = 20484;
  return { schema: 'evolve-network-reference-v1', dimension: n, surface: 'fsaverage5', vertex_order: 'left-then-right', labels_used: false,
    reference_count: 10, version: 'SYNTHETIC-TEST-ONLY', max_reference_rms: 1,
    contract: { feature_spec_hash: 'synthetic-spec', protocol: 'synthetic-10s', runtime_versions: { torch: 'test-only' } },
    mean_f32: Buffer.alloc(n * 4).toString('base64'), scale_f32: floatBytes(Array(n).fill(1)).toString('base64'),
    network_u8: Buffer.from(Array.from({ length: n }, (_, i) => i % 7 + 1)).toString('base64'),
    maps: keys.map((key, i) => ({ key, index: i + 1, label: key, reference_correlations: Array.from({ length: 10 }, (_, j) => (j - 5) / 10) })),
  };
}
export function featureFixture(candidate, data = referenceFixture()) {
  const raw = floatBytes(Array.from({ length: data.dimension }, (_, i) => i % 7 === 2 ? 1 : 0));
  return { id: candidate.id, media_hash: candidate.media_hash, feature_dim: data.dimension, pooled_f32_base64: raw.toString('base64'), pooled_sha256: sha256(raw), metadata: data.contract };
}
