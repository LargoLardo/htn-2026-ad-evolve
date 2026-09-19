import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyBackend } from '../web/lib/backend-proxy.mjs';
import { fixture } from './helpers.mjs';

const request = (body, headers = {}) => new Request('http://127.0.0.1:3001/api/media', { method: 'POST', headers: { origin: 'http://127.0.0.1:3001', 'content-type': 'video/mp4', ...headers }, body });

test('Next proxy preserves binary uploads and forwards only the content type', async t => {
  const video = await fixture('sample.mp4');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3000/api/media');
    assert.deepEqual(Buffer.from(options.body), video);
    assert.equal(options.headers.get('origin'), null);
    assert.equal(options.headers.get('content-type'), 'video/mp4');
    return Response.json({ id: 'uploaded' }, { status: 201 });
  });
  const response = await proxyBackend(request(video), ['media'], 'http://127.0.0.1:3000');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: 'uploaded' });
});

test('Next proxy rejects foreign origins and oversize bodies before contacting the API', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected upstream request'); });
  assert.equal((await proxyBackend(request('bad', { origin: 'https://attacker.example' }), ['media'], 'http://127.0.0.1:3000')).status, 403);
  assert.equal((await proxyBackend(request('bad', { 'content-length': String(51 * 1024 * 1024) }), ['media'], 'http://127.0.0.1:3000')).status, 413);
  const run = new Request('http://localhost:3001/api/runs', { method: 'POST', body: 'x'.repeat(24001) });
  assert.equal((await proxyBackend(run, ['runs'], 'http://127.0.0.1:3000')).status, 413);
});
