import { createHash, randomUUID } from 'node:crypto';
import { encode } from 'fast-png';
import { accountStore } from './storage.mjs';
import { HttpError } from './auth.mjs';

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const streamOf = value => value instanceof ReadableStream ? value : new Blob([value]).stream();

/** Stream base64 with carry across chunks; never materialize a 50 MiB video in an isolate. */
export function base64JsonStream(body, prefix, suffix) {
  const encoder = new TextEncoder();
  let carry = Buffer.alloc(0);
  const encoded = body.pipeThrough(new TransformStream({
    start(controller) { controller.enqueue(encoder.encode(prefix)); },
    transform(chunk, controller) {
      const bytes = Buffer.concat([carry, Buffer.from(chunk)]), end = bytes.length - bytes.length % 3;
      if (end) controller.enqueue(encoder.encode(bytes.subarray(0, end).toString('base64')));
      carry = Buffer.from(bytes.subarray(end));
    },
    flush(controller) {
      if (carry.length) controller.enqueue(encoder.encode(carry.toString('base64')));
      controller.enqueue(encoder.encode(suffix));
    },
  }));
  return encoded;
}

export async function callMediaService(env, store, asset, action, extra = {}) {
  if (!env.MEDIA_SERVICE_URL) throw new HttpError(503, 'Configure the Baseten media service for video and attention maps.');
  const object = await env.MEDIA.get(store.key(`${asset.mediaHash}.${asset.mediaType === 'video' ? 'mp4' : 'png'}`));
  if (!object) throw new HttpError(404, 'Media not found.');
  const prefix = JSON.stringify({ action, media_hash: asset.mediaHash, ...extra }).slice(0, -1) + ',"media_base64":"';
  const response = await fetch(env.MEDIA_SERVICE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MEDIA_SERVICE_TOKEN || env.BASETEN_API_KEY}` },
    body: base64JsonStream(object.body, prefix, '"}'), signal: AbortSignal.timeout(360_000),
  });
  if (!response.ok) throw new Error(`Media service returned HTTP ${response.status}.`);
  return response.json();
}

export function createMedia(env, accountId) {
  const store = accountStore(env, accountId);
  async function bytesToObject(stream, limit, mimeType) {
    const temp = store.key(`temporary/${randomUUID()}`), digest = createHash('sha256'); let size = 0;
    const reader = streamOf(stream).getReader(), partSize = 5 * 1024 * 1024;
    let buffer = new Uint8Array(partSize), used = 0, upload;
    const parts = [], options = { httpMetadata: { contentType: mimeType } };
    try {
      // R2.put cannot accept a transformed stream with unknown length. Bounded
      // multipart chunks support uploads and generated videos without buffering
      // the complete file or trusting a client-supplied Content-Length.
      for (;;) {
        const { value: chunk, done } = await reader.read(); if (done) break;
        size += chunk.byteLength;
        if (size > limit) throw new HttpError(413, 'Media exceeds its upload size limit.');
        digest.update(chunk);
        for (let offset = 0; offset < chunk.byteLength;) {
          const count = Math.min(partSize - used, chunk.byteLength - offset);
          buffer.set(chunk.subarray(offset, offset + count), used); offset += count; used += count;
          if (used === partSize) {
            upload ??= await env.MEDIA.createMultipartUpload(temp, options);
            parts.push(await upload.uploadPart(parts.length + 1, buffer));
            buffer = new Uint8Array(partSize); used = 0;
          }
        }
      }
      if (!size) throw new HttpError(400, 'Empty media upload.');
      if (upload) {
        if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
        await upload.complete(parts);
      } else await env.MEDIA.put(temp, buffer.subarray(0, used), options);
      return { temp, hash: digest.digest('hex'), size };
    } catch (error) { await reader.cancel().catch(() => {}); await upload?.abort().catch(() => {}); await env.MEDIA.delete(temp); throw error; }
    finally { reader.releaseLock(); }
  }
  async function ingestMedia(bytes, mimeType, { kind = 'uploaded-media', prompt = '', model, signal } = {}) {
    signal?.throwIfAborted();
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(mimeType)) throw new HttpError(415, 'Upload PNG, JPEG, WebP or MP4 media.');
    const mediaType = mimeType === 'video/mp4' ? 'video' : 'image', ext = mediaType === 'video' ? 'mp4' : 'png';
    const source = await bytesToObject(bytes, mediaType === 'image' ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES, mimeType);
    let normalized = source;
    try {
      let info;
      if (mediaType === 'image') {
        info = await env.IMAGES.info((await env.MEDIA.get(source.temp)).body);
        if (![info.width, info.height].every(n => Number.isInteger(n) && n >= 16 && n <= 4096)) throw new HttpError(400, 'Media dimensions must be between 16 and 4096 pixels.');
        const output = await env.IMAGES.input((await env.MEDIA.get(source.temp)).body).output({ format: 'image/png', anim: false });
        normalized = await bytesToObject(output.response().body, MAX_IMAGE_BYTES, 'image/png');
        // EXIF orientation can swap dimensions during normalization. Map boxes
        // must use the stored PNG's geometry, not the uploaded JPEG's headers.
        info = await env.IMAGES.info((await env.MEDIA.get(normalized.temp)).body);
        info = { width: info.width, height: info.height, duration: 10, hasAudio: false };
      }
      const key = store.key(`${normalized.hash}.${ext}`);
      await env.MEDIA.put(key, (await env.MEDIA.get(normalized.temp)).body, { httpMetadata: { contentType: mediaType === 'video' ? 'video/mp4' : 'image/png' } });
      const asset = { url: `/assets/${normalized.hash}.${ext}`, mediaHash: normalized.hash, mediaType, mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png', kind, prompt, ...(model ? { model } : {}) };
      if (mediaType === 'video') info = await callMediaService(env, store, asset, 'inspect');
      Object.assign(asset, { width: info.width, height: info.height, duration: info.duration, hasAudio: info.hasAudio === true });
      if (![asset.width, asset.height].every(n => Number.isInteger(n) && n >= 16 && n <= 4096) || !Number.isFinite(asset.duration) || asset.duration < 1 || asset.duration > 60.1) throw new HttpError(400, 'Invalid media dimensions or duration.');
      await store.putJson(`metadata/${asset.mediaHash}.json`, asset);
      return asset;
    } finally {
      await env.MEDIA.delete(source.temp);
      if (normalized.temp !== source.temp) await env.MEDIA.delete(normalized.temp);
    }
  }
  async function getUploadedAsset(hash) {
    if (!hashPattern.test(hash)) throw new HttpError(400, 'Invalid media ID.');
    const asset = await store.getJson(`metadata/${hash}.json`);
    if (!asset || asset.mediaHash !== hash) throw new HttpError(404, 'Media not found in this account.');
    return asset;
  }
  async function mediaPayload(candidate, { forScoring = false } = {}) {
    const asset = await getUploadedAsset(candidate.asset?.mediaHash);
    if (asset.url !== candidate.asset.url) throw new Error('Media identity mismatch.');
    const mediaKey = store.key(`${asset.mediaHash}.${asset.mediaType === 'video' ? 'mp4' : 'png'}`);
    // Score transport streams from this private R2 key. Vision reads image pixels separately.
    const payload = { id: candidate.id, media_hash: asset.mediaHash, media_type: asset.mediaType, media_key: mediaKey };
    if (!forScoring && asset.mediaType === 'image') {
      const preview = await env.IMAGES.input((await env.MEDIA.get(mediaKey)).body).transform({ width: 768, height: 768, fit: 'scale-down' }).output({ format: 'image/png' });
      payload.media_base64 = Buffer.from(await preview.response().arrayBuffer()).toString('base64');
    }
    return payload;
  }
  async function reviewMedia(candidate) {
    if (candidate.asset.mediaType === 'image') {
      const payload = await mediaPayload(candidate);
      return { images: [{ time: 0, base64: payload.media_base64 }], audio: null, scope: 'still-image' };
    }
    const result = await callMediaService(env, store, candidate.asset, 'review');
    if (result.images?.length !== 6 || result.images.some(frame => !Number.isFinite(frame.time) || typeof frame.base64 !== 'string')) throw new Error('Invalid video review media.');
    return { ...result, audio: result.audio ? Buffer.from(result.audio, 'base64') : null };
  }
  async function maskCell(asset, cell) {
    const source = await env.MEDIA.get(store.key(`${asset.mediaHash}.png`));
    if (!source) throw new HttpError(404, 'Media not found.');
    const pixel = encode({ width: 1, height: 1, data: new Uint8Array([128, 128, 128]), channels: 3 });
    const overlay = env.IMAGES.input(streamOf(pixel)).transform({ width: cell.w, height: cell.h, fit: 'cover' });
    const result = await env.IMAGES.input(source.body).draw(overlay, { left: cell.x, top: cell.y, opacity: 1 }).output({ format: 'image/png' });
    return ingestMedia(result.response().body, 'image/png', { kind: 'occlusion-mask', prompt: `Occluded ${cell.label}` });
  }
  return { ingestMedia, getUploadedAsset, mediaPayload, reviewMedia, maskCell };
}

export async function serveAsset(request, env, accountId, filename) {
  if (!/^[a-f0-9]{64}\.(png|mp4)$/.test(filename)) throw new HttpError(404, 'Media not found.');
  const store = accountStore(env, accountId), key = store.key(filename);
  const head = await env.MEDIA.head(key);
  if (!head) throw new HttpError(404, 'Media not found.');
  const headers = new Headers({ 'Content-Type': filename.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable', 'Vary': 'Cookie, Cf-Access-Jwt-Assertion', 'Accept-Ranges': 'bytes', 'ETag': head.httpEtag });
  let start = 0, end = head.size - 1, status = 200;
  const range = request.headers.get('Range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    start = match[1] ? Number(match[1]) : Math.max(0, head.size - Number(match[2]));
    if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= head.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    status = 206; headers.set('Content-Range', `bytes ${start}-${end}/${head.size}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  const object = request.method === 'HEAD' ? null : await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
  return new Response(object?.body ?? null, { status, headers });
}
