// Existing local server only. Never starts a run or calls a paid provider.
import assert from 'node:assert/strict';
const base = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
const configResponse = await fetch(base + '/api/config');
assert.equal(configResponse.status, 200);
const config = await configResponse.json();
assert.equal(config.videoModel, 'Seedance 2.0');
assert.match(config.tribeStatus, /Percept/);
assert.equal((await fetch(base + '/')).status, 404, 'API server does not serve the frontend');
const runs = await (await fetch(base + '/api/runs')).json();
assert.ok(Array.isArray(runs));
const blocked = await fetch(base + '/api/media', { method: 'POST', headers: { origin: 'https://example.org', 'content-type': 'video/mp4' } });
assert.equal(blocked.status, 403);
console.log(JSON.stringify({ url: base, checks: 'API-only backend, Percept/Seedance configuration, saved-run listing, origin protection; no generation or inference' }));
