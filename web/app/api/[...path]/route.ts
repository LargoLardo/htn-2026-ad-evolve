import { proxyBackend } from '@/lib/backend-proxy.mjs';

const API_ORIGIN = process.env.EVOLVE_API_ORIGIN ?? 'http://127.0.0.1:3000';
type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: Context) {
  return proxyBackend(request, (await context.params).path, API_ORIGIN);
}

export async function POST(request: Request, context: Context) {
  return proxyBackend(request, (await context.params).path, API_ORIGIN);
}
