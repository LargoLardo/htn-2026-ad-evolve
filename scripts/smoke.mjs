// Read-only asset checks, then one explicitly offline demo experiment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:3000';
// The interface is the Next.js app in web/; this process serves only the API
// and the generated-asset store, so there is no static site to probe.
const config = await fetch(base + '/api/config');
assert.equal(config.status, 200, '/api/config');
assert.ok((await config.json()).limits, '/api/config limits');
const notStatic = await fetch(base + '/');
assert.equal(notStatic.status, 404, 'root is no longer a static site');
const blocked = await fetch(base + '/api/runs', { method: 'POST', headers: { origin: 'https://example.org', 'content-type': 'application/json' }, body: '{}' });
assert.equal(blocked.status, 403);
const invalid = await fetch(base + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'Invalid', description: 'Test', goal: 'Test', population: 999 }) });
assert.equal(invalid.status, 400);
const brief = {
  product: 'PULSE', description: 'A botanical sparkling water with bright citrus and no added sugar. Made for the everyday reset.',
  audience: 'Creative professionals looking for an afternoon reset', goal: 'Make an everyday break feel refreshing and desirable. Inspire people to try PULSE.',
  weights: { joy: 30, trust: 20, curiosity: 35, desire: 15 }, rounds: 3, population: 8, shortlist: 3, seed: 42, mode: 'demo', scorer: 'proxy',
};
const created = await fetch(base + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(brief) });
assert.equal(created.status, 202);
let run = await created.json();
const deadline = Date.now() + 10000;
while (run.status === 'running' && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 100));
  run = await (await fetch(`${base}/api/runs/${run.id}`)).json();
}
assert.equal(run.status, 'completed');
assert.equal(run.rounds.length, 3);
assert.equal(run.metrics.generated, 24);
assert.equal(run.finalists.length, 3);
assert.equal(run.metrics.tribeCalls, 0);
for (const finalist of run.finalists) {
  assert.equal(finalist.scores.source, 'heuristic');
  assert.equal((await fetch(base + finalist.asset.url)).status, 200);
}
const exported = await fetch(`${base}/api/runs/${run.id}/export`);
assert.match(exported.headers.get('content-disposition'), /attachment/);
assert.deepEqual(await exported.json(), run);
assert.deepEqual(JSON.parse(await readFile(new URL(`../data/runs/${run.id}.json`, import.meta.url))), run);
console.log(JSON.stringify({ url: `${base}/#run=${run.id}`, status: run.status, finalists: run.finalists.length, metrics: run.metrics, checks: 'assets, origin, input, complete demo, export, disk persistence' }, null, 2));
