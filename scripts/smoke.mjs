// Existing local server only. Never starts a run or calls a paid provider.
import assert from 'node:assert/strict';
const base = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
for (const path of ['/', '/app.js', '/style.css', '/fonts/fonts.css', '/fonts/dm-sans-400-700.woff2', '/fonts/manrope-400-800.woff2']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  assert.ok((await response.arrayBuffer()).byteLength > 0, path);
}
const config = await (await fetch(base + '/api/config')).json();
assert.equal(config.videoModel, 'Seedance 2.0');
assert.match(config.tribeStatus, /Percept/);
const runs = await (await fetch(base + '/api/runs')).json();
assert.ok(Array.isArray(runs));
const blocked = await fetch(base + '/api/media', { method: 'POST', headers: { origin: 'https://example.org', 'content-type': 'video/mp4' } });
assert.equal(blocked.status, 403);
console.log(JSON.stringify({ url: base, checks: 'static assets, Percept/Seedance configuration, saved-run listing, origin protection; no generation or inference' }));
