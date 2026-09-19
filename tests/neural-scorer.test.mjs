import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReference, scorePattern, validateFeatureResult, sha256 } from '../lib/neural-scorer.mjs';
import { featureFixture, referenceFixture, floatBytes } from './neural-fixture.mjs';

test('spatial correlation and frozen percentiles have known endpoints and never depend on a batch', () => {
  const reference = prepareReference(referenceFixture(), 'synthetic-hash');
  const vector = Array.from({ length: 20484 }, (_, i) => i % 7 === 2 ? 1 : 0);
  const first = scorePattern(vector, reference);
  assert.ok(Math.abs(first.patterns.dorsal_attention.correlation - 1) < 1e-12);
  assert.equal(first.targetPercentile, 100);
  assert.equal(scorePattern(vector.map(v => -v), reference).targetPercentile, 0);
  scorePattern(vector.map(v => 100 * v), reference);
  assert.deepEqual(scorePattern(vector, reference), first);
  assert.equal(scorePattern(vector.map(v => 100 * v), reference).usableForSelection, false);
  assert.throws(() => scorePattern(Array(20484).fill(0), reference), /constant/);
  assert.throws(() => scorePattern(vector, reference, 'audio'), /Invalid/);
});

test('feature validation rejects protocol/runtime, identity, dimension, checksum and nonfinite mismatches', () => {
  const reference = prepareReference(referenceFixture(), 'synthetic-hash');
  const expected = { id: '1', media_hash: 'actual-image-hash' }, result = featureFixture(expected);
  assert.equal(validateFeatureResult(result, reference, expected).length, 20484);
  for (const changed of [
    { media_hash: 'another-image' }, { id: '2' }, { feature_dim: 10 }, { pooled_sha256: 'bad' },
    { metadata: { ...result.metadata, protocol: 'synthetic-5s' } },
    { metadata: { ...result.metadata, runtime_versions: {} } },
  ]) assert.throws(() => validateFeatureResult({ ...result, ...changed }, reference, expected));
  const nonfinite = floatBytes(Array(20484).fill(NaN));
  assert.throws(() => validateFeatureResult({ ...result, pooled_f32_base64: nonfinite.toString('base64'), pooled_sha256: sha256(nonfinite) }, reference, expected), /Nonfinite/);
});

test('fixed per-vertex reference normalization is applied before spatial correlation', () => {
  const data = referenceFixture(), reference = prepareReference(data, 'synthetic-hash');
  const vector = Array.from({ length: 20484 }, (_, i) => Math.sin(i / 10));
  const before = scorePattern(vector, reference);
  const shifted = { ...reference, mean: reference.mean.map((v, i) => v + i / 100), scale: reference.scale.map(() => 3) };
  const after = scorePattern(vector.map((v, i) => v * 3 + i / 100), shifted);
  for (const key of Object.keys(before.patterns)) assert.ok(Math.abs(before.patterns[key].correlation - after.patterns[key].correlation) < 1e-12);
});
