import { createRemoteJWKSet, jwtVerify } from 'jose';
import { sha256 } from '../../lib/scoring-validation.mjs';

const issuers = new Map();
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function authenticate(request, env) {
  const url = new URL(request.url);
  if (env.AUTH_MODE === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const name = request.headers.get('X-Local-Account') || 'developer';
    return { accountId: sha256(`local:${name}`) };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || env.AUTH_MODE !== 'access') throw new HttpError(503, 'Configure Cloudflare Access before enabling the hosted app.');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) throw new HttpError(503, 'Invalid Access team domain.');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'Sign in through Cloudflare Access.');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (!issuers.has(issuer)) issuers.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
  try {
    const { payload } = await jwtVerify(token, issuers.get(issuer), { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'] });
    if (typeof payload.sub !== 'string' || !payload.sub || !payload.exp) throw new Error('Missing user identity');
    // One account per verified Access subject. Never trust a client account header.
    return { accountId: sha256(`${issuer}:${payload.sub}`) };
  } catch { throw new HttpError(401, 'Your sign-in could not be verified.'); }
}
export function requireSameOrigin(request) {
  if (['GET', 'HEAD'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Only same-origin requests are allowed.');
}
