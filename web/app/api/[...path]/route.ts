import { NextRequest } from 'next/server';

const API_ORIGIN = process.env.EVOLVE_API_ORIGIN ?? 'http://127.0.0.1:3000';

/**
 * Server-side proxy to server.mjs.
 *
 * This cannot be a next.config rewrite. localRequest() in server.mjs rejects any
 * request whose Origin port differs from its Host port, and a rewrite forwards
 * the browser's Origin header verbatim -- so a POST from the page on :3001 gets
 * a blanket 403 from the API on :3000. (GETs happen to pass only because
 * browsers omit Origin on same-origin GETs, which made this look like it worked.)
 *
 * Proxying here lets us drop Origin entirely, which is what server.mjs treats as
 * a same-origin local request. server.mjs stays untouched.
 */
async function proxy(request: NextRequest, path: string[]) {
  const url = new URL(request.url);
  const target = `${API_ORIGIN}/api/${path.map(encodeURIComponent).join('/')}${url.search}`;

  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: request.method, headers, body });
  } catch {
    return Response.json(
      { error: `Could not reach the Evolve server at ${API_ORIGIN}. Is it running?` },
      { status: 502 }
    );
  }

  // Preserve the attachment filename that /export sets, and the content type.
  const out = new Headers();
  for (const key of ['content-type', 'content-disposition', 'cache-control']) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}
