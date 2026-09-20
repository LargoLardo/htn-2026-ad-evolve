import raw from '../../worker/percept_spec.json';
import { sha256 } from '../../lib/scoring-validation.mjs';
const contract = { ...JSON.parse(raw), hash: sha256(raw) };
export const getScoringContract = () => contract;
