import { expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { authenticate } from '../src/auth.mjs';
import { sha256 } from '../../lib/scoring-validation.mjs';

it('verifies Access signature, audience and expiry and ignores client account headers', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const env = { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: 'auth-test.cloudflareaccess.com', ACCESS_AUD: 'test-app' };
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ keys: [jwk] }));
  const token = async (audience = env.ACCESS_AUD, expires = '1h') => new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('user-a').setIssuer(issuer).setAudience(audience).setExpirationTime(expires).sign(privateKey);
  const request = value => new Request('https://app.example/api/runs', { headers: { 'Cf-Access-Jwt-Assertion': value, 'X-Local-Account': 'attacker' } });
  try {
    const signed = await token();
    expect(await authenticate(request(signed), env)).toEqual({ accountId: sha256(`${issuer}:user-a`) });
    await expect(authenticate(request(await token('another-app')), env)).rejects.toMatchObject({ status: 401 });
    await expect(authenticate(request(await token(env.ACCESS_AUD, 1)), env)).rejects.toMatchObject({ status: 401 });
    const parts = signed.split('.'); parts[1] = Buffer.from(JSON.stringify({ sub: 'user-b', iss: issuer, aud: env.ACCESS_AUD, exp: 9999999999 })).toString('base64url');
    await expect(authenticate(request(parts.join('.')), env)).rejects.toMatchObject({ status: 401 });
  } finally { mock.mockRestore(); }
});
