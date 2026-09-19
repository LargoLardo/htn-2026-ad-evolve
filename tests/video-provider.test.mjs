import test from 'node:test';
import assert from 'node:assert/strict';
import { renderVideo } from '../lib/video-provider.mjs';
import { fixture, isolatedConfig } from './helpers.mjs';
const brief = { aspectRatio: '9:16', videoDuration: 10 };

test('Seedance request, authenticated download redirect and completed-job reuse', async t => {
  await isolatedConfig(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    url = String(url); calls.push(url);
    if (url.endsWith('/text-to-video')) {
      assert.equal(options.headers['X-API-Key'], 'test-pika-secret');
      assert.match(options.headers['Idempotency-Key'], /^[a-f0-9]{64}$/);
      assert.deepEqual(JSON.parse(options.body), { prompt: 'Notebook reveal', resolution: '720p', ratio: '9:16', duration: 10 });
      return Response.json({ id: 'media_123', status: 'queued' });
    }
    if (url.endsWith('/jobs/media_123')) return Response.json({ status: 'completed' });
    if (url.endsWith('/content')) return Response.json({ url: 'https://api.dev.pika.art/v1/files/video.mp4' });
    if (url.includes('/v1/files/')) {
      assert.equal(options.headers['X-API-Key'], 'test-pika-secret');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/video.mp4' } });
    }
    assert.equal(url, 'https://cdn.example.com/video.mp4');
    assert.deepEqual(options.headers, {});
    return new Response(await fixture('sample.mp4'));
  });
  const first = await renderVideo('Notebook reveal', brief);
  assert.equal(first.mediaType, 'video');
  assert.equal(first.model, 'Seedance 2.0');
  assert.equal((await renderVideo('Notebook reveal', brief)).cached, true);
  assert.equal(calls.length, 5);
});

test('cancelling polling retains the job so retry does not submit generation again', async t => {
  await isolatedConfig(t);
  let submits = 0, polls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url) => {
    url = String(url);
    if (url.endsWith('/text-to-video')) { submits++; return Response.json({ id: 'saved-job', status: 'queued' }); }
    if (url.endsWith('/jobs/saved-job')) {
      if (!polls++) { controller.abort(); return Response.json({ status: 'running' }); }
      return Response.json({ status: 'completed' });
    }
    if (url.endsWith('/content')) return Response.json({ url: 'https://cdn.example.com/video.mp4' });
    return new Response(await fixture('sample.mp4'));
  });
  await assert.rejects(renderVideo('Same prompt', brief, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await renderVideo('Same prompt', brief)).mediaType, 'video');
  assert.equal(submits, 1);
  assert.equal(polls, 2);
});

test('failed jobs stay explicit and HTTP errors omit private provider text', async t => {
  await isolatedConfig(t);
  let submits = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/text-to-video')) { submits++; return Response.json({ id: 'failed-job' }); }
    return Response.json({ status: 'failed', error: 'private details' });
  });
  await assert.rejects(renderVideo('Failure', brief), /generation failed/);
  await assert.rejects(renderVideo('Failure', brief), /generation failed/);
  assert.equal(submits, 1);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'private details' }, { status: 403 }));
  await assert.rejects(renderVideo('Another', brief), error => /HTTP 403/.test(error.message) && !/private/.test(error.message));
});
