import { HttpError } from './auth.mjs';

export const accountPrefix = accountId => {
  if (!/^[a-f0-9]{64}$/.test(accountId)) throw new Error('Invalid account identity');
  return `${accountId}/`;
};
export function accountStore(env, accountId) {
  const prefix = accountPrefix(accountId);
  return {
    key: name => prefix + name,
    async getJson(name) { const value = await env.MEDIA.get(prefix + name); return value ? value.json() : null; },
    async putJson(name, value) { await env.MEDIA.put(prefix + name, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }); },
    async cachedJson(name) { const value = await env.MEDIA.get(`${prefix}cache/${name}.json`); return value ? value.json() : null; },
    async saveCachedJson(name, value) { await env.MEDIA.put(`${prefix}cache/${name}.json`, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }); },
    async readMap(hash) { const value = await env.MEDIA.get(`${prefix}maps/${hash}.json`); return value ? value.json() : null; },
  };
}
export function runDocument(env, accountId, runId) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new HttpError(404, 'Run not found.');
  return env.RUNS.get(env.RUNS.idFromName(`${accountPrefix(accountId)}${runId}`));
}
export async function indexRun(env, accountId, run) {
  await env.INDEX.prepare('INSERT INTO runs (account_id,id,product,status,stage,created_at,metrics_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET status=excluded.status,stage=excluded.stage,metrics_json=excluded.metrics_json')
    .bind(accountId, run.id, run.brief.product, run.status, run.stage, run.createdAt, JSON.stringify(run.metrics)).run();
}
export async function listRuns(env, accountId) {
  const { results } = await env.INDEX.prepare('SELECT id,product,status,stage,created_at,metrics_json FROM runs WHERE account_id=? ORDER BY created_at DESC LIMIT 200').bind(accountId).all();
  return results.map(row => ({ id: row.id, product: row.product, status: row.status, stage: row.stage, createdAt: row.created_at, metrics: JSON.parse(row.metrics_json) }));
}
