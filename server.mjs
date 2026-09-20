import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, evolveRun, LIMITS, validateBrief } from './lib/evolution.mjs';
import * as defaultProviders from './lib/providers.mjs';
import { ingestMedia, getUploadedAsset, assetsDir, MAX_MEDIA_BYTES } from './lib/media.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data', 'runs');
// Where scripts/build-demo-maps.mjs writes its artifacts.
const mapsPath = hash => path.join(process.env.EVOLVE_MAPS_DIR || 'data/maps', `${hash}-maps.json`);

const MIME = { '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

async function save(run, directory = DATA) {
  const target = path.join(directory, `${run.id}.json`);
  await writeFile(`${target}.tmp`, JSON.stringify(run, null, 2));
  await rename(`${target}.tmp`, target);
}

function json(response, status, body, extra = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Use Content-Type: application/json.'), { status: 415 });
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > LIMITS.maxBodyBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

function localRequest(request) {
  const host = request.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  if (!request.headers.origin) return true;
  try {
    const origin = new URL(request.headers.origin);
    return origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === new URL(`http://${host}`).port;
  } catch { return false; }
}

export async function createAppServer({ providers = defaultProviders, dataDir = DATA } = {}) {
  await mkdir(dataDir, { recursive: true });
  const runs = new Map(); const active = new Map();
  // ponytail: local JSON files and two concurrent runs; use a durable job queue for multi-user hosting.
  for (const name of await readdir(dataDir)) {
    if (!/^[a-f\d-]{36}\.json$/i.test(name)) continue;
    try {
      const run = JSON.parse(await readFile(path.join(dataDir, name), 'utf8'));
      if (run.status === 'running') {
        run.status = 'failed'; run.stage = 'failed'; run.error = 'Server restarted before this run finished.';
        run.events.push({ time: new Date().toISOString(), message: run.error });
        await save(run, dataDir);
      }
      runs.set(run.id, run);
    } catch (error) { console.warn(`Could not load a saved run: ${error.message}`); }
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      if (!localRequest(request)) return json(response, 403, { error: 'Only same-origin local requests are allowed.' });
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      if (request.method === 'GET' && pathname === '/api/config') return json(response, 200, { ...providers.capabilities(), limits: LIMITS });
      if (request.method === 'GET' && pathname === '/api/runs') return json(response, 200, [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(run => ({ id: run.id, status: run.status, stage: run.stage, product: run.brief.product, createdAt: run.createdAt, metrics: run.metrics })));
      // Precomputed attention/impact maps for one uploaded image, keyed by its
      // media hash. Built offline by scripts/build-demo-maps.mjs because a 3x3
      // impact map is ten GPU passes and must not be paid for during a demo.
      // Which media already has precomputed maps. The UI needs this to offer a
      // picker; probing every candidate image with a 404 would be worse.
      if (request.method === 'GET' && pathname === '/api/maps') {
        try {
          const names = await readdir(process.env.EVOLVE_MAPS_DIR || 'data/maps');
          return json(response, 200, names.flatMap(name => name.match(/^([a-f0-9]{64})-maps\.json$/)?.[1] ?? []));
        } catch { return json(response, 200, []); }
      }
      // The full-resolution attention heatmap. DeepGaze produces a continuous
      // 1024px density; reducing it to grid cells for display throws that away,
      // so the UI overlays this greyscale PNG directly.
      if (request.method === 'GET' && /^\/api\/maps\/[a-f0-9]{64}\/attention\.png$/.test(pathname)) {
        const file = mapsPath(pathname.split('/').at(-2)).replace(/-maps\.json$/, '-attention.png');
        try {
          const bytes = await readFile(file);
          response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': bytes.length });
          return response.end(request.method === 'HEAD' ? undefined : bytes);
        } catch { return json(response, 404, { error: 'No attention heatmap for this media.' }); }
      }
      if (request.method === 'GET' && /^\/api\/maps\/[a-f0-9]{64}$/.test(pathname)) {
        try { return json(response, 200, JSON.parse(await readFile(mapsPath(pathname.split('/').at(-1)), 'utf8'))); }
        catch { return json(response, 404, { error: 'No precomputed maps for this media.' }); }
      }
      if (request.method === 'POST' && pathname === '/api/media') {
        const type = request.headers['content-type']?.split(';')[0];
        if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(type)) return json(response, 415, { error: 'Upload PNG, JPEG, WebP or MP4 media.' });
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > MAX_MEDIA_BYTES) return json(response, 413, { error: 'Media exceeds 50 MiB.' });
          chunks.push(chunk);
        }
        try {
          const asset = await ingestMedia(Buffer.concat(chunks), type);
          return json(response, 201, { id: asset.mediaHash, asset });
        } catch (error) { return json(response, 400, { error: error.message }); }
      }
      if (request.method === 'POST' && pathname === '/api/runs') {
        if (active.size >= LIMITS.activeRuns) return json(response, 429, { error: 'Two runs are already active. Wait for one to finish or cancel it.' });
        let brief;
        try { brief = validateBrief(await readJson(request)); }
        catch (error) { return json(response, error.status ?? 400, { error: error.message }); }
        const capabilities = providers.capabilities();
        if (!capabilities.liveResearch || !(brief.mediaType === 'video' ? capabilities.liveVideos : capabilities.liveImages)) return json(response, 400, { error: 'Configure OpenAI for research/review and the selected image or Seedance video provider.' });
        if (brief.scorer === 'tribe' && !capabilities.tribe) return json(response, 400, { error: 'Percept scoring requires the updated TRIBE scoring endpoint. Decoder training is paused.' });
        if (active.size >= LIMITS.activeRuns) return json(response, 429, { error: 'Two runs are already active. Wait for one to finish or cancel it.' });
        if (brief.referenceMediaIds?.length) {
          try { brief.referenceAssets = await Promise.all(brief.referenceMediaIds.map(getUploadedAsset)); }
          catch { return json(response, 400, { error: 'A reference image is missing or invalid. Upload it again.' }); }
          if (brief.referenceAssets.some(asset => asset.mediaType !== 'image')) return json(response, 400, { error: 'Reference media must be still images.' });
        }
        if (brief.originalMediaId) {
          try { brief.originalAsset = await getUploadedAsset(brief.originalMediaId); }
          catch { return json(response, 400, { error: 'Original media is missing or invalid. Upload it again.' }); }
          if (brief.originalAsset.mediaType !== brief.mediaType) return json(response, 400, { error: 'The original must match the selected image/video ad format.' });
        }
        if (active.size >= LIMITS.activeRuns) return json(response, 429, { error: 'Two runs are already active. Wait for one to finish or cancel it.' });
        const run = createRun(brief);
        const controller = new AbortController();
        runs.set(run.id, run); active.set(run.id, controller);
        try { await save(run, dataDir); }
        catch (error) { runs.delete(run.id); active.delete(run.id); throw error; }
        json(response, 202, run);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90 * 60 * 1_000)]);
        void evolveRun(run, providers, { signal, onUpdate: run => save(run, dataDir) }).catch(error => {
          run.status = 'failed'; run.stage = 'failed'; run.error = `Run storage failed: ${error.message}`;
          console.error(run.error);
        }).finally(() => active.delete(run.id));
        return;
      }
      const route = pathname.match(/^\/api\/runs\/([a-f\d-]{36})(?:\/(cancel|export))?$/i);
      if (route) {
        const run = runs.get(route[1]);
        if (!run) return json(response, 404, { error: 'Run not found.' });
        if (request.method === 'GET' && !route[2]) return json(response, 200, run);
        if (request.method === 'GET' && route[2] === 'export') return json(response, 200, run, { 'Content-Disposition': `attachment; filename="evolve-${run.id}.json"` });
        if (request.method === 'POST' && route[2] === 'cancel') {
          active.get(run.id)?.abort(new DOMException('User cancelled the run.', 'AbortError'));
          return json(response, 200, { id: run.id, status: active.has(run.id) ? 'cancelling' : run.status });
        }
        return json(response, 405, { error: 'Method not allowed.' });
      }
      if (pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found.' });
      if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: 'Method not allowed.' });
      // This process is the API and the generated-asset store. The interface is
      // the Next.js app in web/, which proxies /api and /assets through to here,
      // so there is no static site to serve any more.
      const asset = pathname.startsWith('/assets/');
      if (!asset) return json(response, 404, { error: 'Not found. The interface is served by the web/ Next.js app.' });
      const base = assetsDir();
      const requested = pathname.slice('/assets/'.length);
      const target = path.resolve(base, requested);
      const relative = path.relative(base, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return json(response, 404, { error: 'File not found.' });
      try {
        const info = await stat(target);
        if (!info.isFile() || !MIME[path.extname(target)]) return json(response, 404, { error: 'File not found.' });
        const headers = { 'Content-Type': MIME[path.extname(target)], 'Cache-Control': asset ? 'public, max-age=31536000, immutable' : 'no-cache', 'Accept-Ranges': 'bytes' };
        let start = 0, end = info.size - 1, status = 200;
        if (request.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
          if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return response.end(); }
          if (!range[1]) start = Math.max(0, info.size - Number(range[2]));
          else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return response.end(); }
          status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
        }
        response.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
        if (request.method === 'HEAD') return response.end();
        const stream = createReadStream(target, { start, end });
        response.on('close', () => stream.destroy());
        stream.on('error', () => response.destroy());
        stream.pipe(response);

      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return json(response, 404, { error: 'File not found.' });
        throw error;
      }
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof URIError ? 400 : 500, { error: error instanceof URIError ? 'Invalid URL encoding.' : 'The local server could not complete this request.' });
      else response.end();
      console.error(error.message);
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.on('close', () => { for (const controller of active.values()) controller.abort(new DOMException('Server closed.', 'AbortError')); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const server = await createAppServer();
  server.listen(port, '127.0.0.1', () => console.log(`Evolve Studio is ready at http://127.0.0.1:${port}`));
}
