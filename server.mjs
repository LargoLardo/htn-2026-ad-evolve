import http from 'node:http';
import { readFile, readdir, mkdir, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, evolveRun, LIMITS, validateBrief } from './lib/evolution.mjs';
import * as providers from './lib/providers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data', 'runs');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

async function save(run) {
  const target = path.join(DATA, `${run.id}.json`);
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

export async function createAppServer() {
  await mkdir(DATA, { recursive: true });
  const runs = new Map(); const active = new Map();
  // ponytail: local JSON files and two concurrent runs; use a durable job queue for multi-user hosting.
  for (const name of await readdir(DATA)) {
    if (!/^[a-f\d-]{36}\.json$/i.test(name)) continue;
    try {
      const run = JSON.parse(await readFile(path.join(DATA, name), 'utf8'));
      if (run.status === 'running') {
        run.status = 'failed'; run.stage = 'failed'; run.error = 'Server restarted before this run finished.';
        run.events.push({ time: new Date().toISOString(), message: run.error });
        await save(run);
      }
      runs.set(run.id, run);
    } catch (error) { console.warn(`Could not load a saved run: ${error.message}`); }
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      if (!localRequest(request)) return json(response, 403, { error: 'Only same-origin local requests are allowed.' });
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      if (request.method === 'GET' && pathname === '/api/config') return json(response, 200, { ...providers.capabilities(), limits: LIMITS });
      if (request.method === 'GET' && pathname === '/api/runs') return json(response, 200, [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(run => ({ id: run.id, status: run.status, stage: run.stage, product: run.brief.product, createdAt: run.createdAt, metrics: run.metrics })));
      if (request.method === 'POST' && pathname === '/api/runs') {
        if (active.size >= LIMITS.activeRuns) return json(response, 429, { error: 'Two runs are already active. Wait for one to finish or cancel it.' });
        let brief;
        try { brief = validateBrief(await readJson(request)); }
        catch (error) { return json(response, error.status ?? 400, { error: error.message }); }
        const capabilities = providers.capabilities();
        if (brief.mode === 'live' && (!capabilities.liveResearch || !capabilities.liveImages)) return json(response, 400, { error: 'Configure live research and image providers before using live mode.' });
        if (brief.scorer === 'tribe' && !capabilities.tribe) return json(response, 400, { error: 'TRIBE requires a configured external worker with a human-calibrated emotion readout.' });
        if (active.size >= LIMITS.activeRuns) return json(response, 429, { error: 'Two runs are already active. Wait for one to finish or cancel it.' });
        const run = createRun(brief);
        const controller = new AbortController();
        runs.set(run.id, run); active.set(run.id, controller);
        try { await save(run); }
        catch (error) { runs.delete(run.id); active.delete(run.id); throw error; }
        json(response, 202, run);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60 * 1_000)]);
        void evolveRun(run, providers, { signal, onUpdate: save }).catch(error => {
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
      const asset = pathname.startsWith('/assets/');
      const base = path.join(ROOT, asset ? 'data/assets' : 'public');
      const requested = asset ? pathname.slice('/assets/'.length) : pathname === '/' ? 'index.html' : pathname.slice(1);
      const target = path.resolve(base, requested);
      const relative = path.relative(base, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return json(response, 404, { error: 'File not found.' });
      try {
        const info = await stat(target);
        if (!info.isFile() || !MIME[path.extname(target)]) return json(response, 404, { error: 'File not found.' });
        response.writeHead(200, { 'Content-Type': MIME[path.extname(target)], 'Cache-Control': asset ? 'public, max-age=31536000, immutable' : 'no-cache', 'Content-Length': info.size });
        response.end(request.method === 'HEAD' ? undefined : await readFile(target));
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
  server.requestTimeout = 30_000;
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
