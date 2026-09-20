import { readFileSync } from 'node:fs';
import { sha256 } from './scoring-validation.mjs';
export * from './scoring-validation.mjs';

export function getScoringContract() {
  const raw = readFileSync(new URL('../worker/neural_spec.json', import.meta.url));
  return { ...JSON.parse(raw), hash: sha256(raw) };
}
