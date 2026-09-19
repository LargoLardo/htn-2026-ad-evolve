import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from './scoring-contract.mjs';

const exec = promisify(execFile);
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const assetsDir = () => resolve(process.env.EVOLVE_ASSETS_DIR || 'data/assets');
export function ffmpegBin() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  for (const dir of (process.env.PATH || '').split(':')) if (existsSync(join(dir, 'ffmpeg'))) return join(dir, 'ffmpeg');
  const bundled = resolve('data/venv-mps/lib/python3.11/site-packages/imageio_ffmpeg/binaries');
  if (existsSync(bundled)) {
    const name = readdirSync(bundled).find(name => /^ffmpeg-/.test(name));
    if (name) return join(bundled, name);
  }
  return 'ffmpeg';
}
export async function ffmpeg(args, { signal } = {}) {
  try { return await exec(ffmpegBin(), ['-nostdin', '-hide_banner', '-y', ...args], { signal, timeout: 180_000, maxBuffer: 2_000_000 }); }
  catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new Error('FFmpeg is required for media uploads and video review. Set FFMPEG_BIN.');
    throw new Error('The media could not be decoded or processed by FFmpeg.');
  }
}
export async function inspectMedia(path, type, { signal } = {}) {
  let stderr;
  try { ({ stderr } = await exec(ffmpegBin(), ['-nostdin', '-hide_banner', '-i', path], { signal, timeout: 30_000, maxBuffer: 2_000_000 })); }
  catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new Error('FFmpeg is required. Set FFMPEG_BIN.');
    if (error.killed || typeof error.stderr !== 'string') throw new Error('Media inspection failed.');
    stderr = error.stderr;
  }
  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  const time = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const width = Number(dimensions?.[1]), height = Number(dimensions?.[2]);
  const duration = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0;
  if (!dimensions || width < 16 || height < 16 || width > 4096 || height > 4096) throw new Error('Media dimensions must be between 16 and 4096 pixels.');
  if (type === 'video' && (!/Input #0, mov,mp4/.test(stderr) || !Number.isFinite(duration) || duration < 1 || duration > 60.1)) throw new Error('Upload an MP4 video between 1 and 60 seconds.');
  return { width, height, duration: type === 'image' ? 10 : duration, hasAudio: type === 'video' && /Audio:/.test(stderr) };
}
export async function ingestMedia(bytes, mimeType, { signal, kind = 'uploaded-media', prompt = '', model } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error('Media must be no larger than 50 MiB.');
  if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(mimeType)) throw new Error('Use a PNG, JPEG, WebP or MP4 file.');
  const mediaType = mimeType === 'video/mp4' ? 'video' : 'image';
  const temp = await mkdtemp(join(tmpdir(), 'evolve-upload-'));
  try {
    const source = join(temp, mediaType === 'video' ? 'source.mp4' : 'source.image');
    await writeFile(source, bytes);
    const info = await inspectMedia(source, mediaType, { signal });
    if (mediaType === 'image') {
      const target = join(temp, 'normalized.png');
      await ffmpeg(['-loglevel', 'error', '-i', source, '-frames:v', '1', '-pix_fmt', 'rgb24', target], { signal });
      bytes = await readFile(target);
    }
    const mediaHash = sha256(bytes), ext = mediaType === 'video' ? 'mp4' : 'png';
    await mkdir(assetsDir(), { recursive: true });
    await writeFile(join(assetsDir(), `${mediaHash}.${ext}`), bytes);
    const asset = { url: `/assets/${mediaHash}.${ext}`, mediaHash, mediaType, mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png', ...info, kind, prompt, ...(model ? { model } : {}) };
    await writeFile(join(assetsDir(), `${mediaHash}.json`), JSON.stringify(asset));
    return asset;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export async function getUploadedAsset(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid original media ID.');
  const asset = JSON.parse(await readFile(join(assetsDir(), `${hash}.json`), 'utf8'));
  await mediaPayload({ id: 'original', asset });
  return asset;
}
export async function mediaPayload(candidate) {
  const asset = candidate.asset;
  if (!asset || !/^\/assets\/[a-f0-9]{64}\.(png|mp4)$/.test(asset.url)) throw new Error('Evaluation requires an actual PNG or MP4 asset.');
  const bytes = await readFile(join(assetsDir(), asset.url.split('/').at(-1)));
  const hash = sha256(bytes), mediaType = asset.url.endsWith('.mp4') ? 'video' : 'image';
  if (hash !== asset.mediaHash || !asset.url.includes(hash) || bytes.length > MAX_MEDIA_BYTES) throw new Error('Media content hash mismatch or size limit exceeded.');
  return { id: candidate.id, media_hash: hash, media_type: mediaType, media_base64: bytes.toString('base64') };
}
export async function reviewMedia(candidate, { signal } = {}) {
  const payload = await mediaPayload(candidate);
  if (payload.media_type === 'image') return { images: [{ time: 0, base64: payload.media_base64 }], audio: null, scope: 'still-image' };
  const path = join(assetsDir(), candidate.asset.url.split('/').at(-1));
  const info = await inspectMedia(path, 'video', { signal });
  const temp = await mkdtemp(join(tmpdir(), 'evolve-review-'));
  try {
    const images = [];
    for (let i = 0; i < 6; i++) {
      const time = Math.max(0, (info.duration - 0.1) * i / 5), target = join(temp, `${i}.jpg`);
      await ffmpeg(['-loglevel', 'error', '-ss', String(time), '-i', path, '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-q:v', '3', target], { signal });
      images.push({ time, base64: (await readFile(target)).toString('base64') });
    }
    let audio = null;
    if (info.hasAudio) {
      const target = join(temp, 'speech.wav');
      await ffmpeg(['-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', target], { signal });
      audio = await readFile(target);
    }
    return { images, audio, scope: 'six-sampled-frames-and-audio-transcript' };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
