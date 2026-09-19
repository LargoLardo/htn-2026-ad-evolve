/** Forward API requests without changing media bytes. Validate the browser's
 * origin here before omitting it on the hop to the local API port.
 * @param {Request} request
 * @param {string[]} path
 * @param {string} apiOrigin
 */
export async function proxyBackend(request, path, apiOrigin) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const source = new URL(origin);
      if (source.protocol !== url.protocol || source.host !== (request.headers.get('host') || url.host)) throw new Error('origin mismatch');
    } catch { return Response.json({ error: 'Only same-origin requests are allowed.' }, { status: 403 }); }
  }
  const target = `${apiOrigin}/api/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const limit = path.length === 1 && path[0] === 'media' ? 50 * 1024 * 1024 : 24_000;
    if (Number(request.headers.get('content-length')) > limit) return Response.json({ error: 'Request body is too large.' }, { status: 413 });
    const reader = request.body?.getReader();
    const chunks = []; let length = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > limit) { await reader.cancel(); return Response.json({ error: 'Request body is too large.' }, { status: 413 }); }
        chunks.push(value);
      }
    }
    body = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  }
  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, headers, body, cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]) });
  } catch {
    return Response.json({ error: 'Could not reach the Advolve API server. Check that it is running.' }, { status: 502 });
  }
  const out = new Headers();
  for (const key of ['content-type', 'content-disposition', 'cache-control']) {
    const value = upstream.headers.get(key); if (value) out.set(key, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
