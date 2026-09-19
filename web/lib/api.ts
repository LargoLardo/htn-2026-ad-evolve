import type { Brief, Config, Run, RunSummary } from './types';

/** Every error body from server.mjs is `{error: string}`; surface that message. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');

  const response = await fetch(path, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status}).`);
  return data as T;
}

export const getConfig = () => api<Config>('/api/config');
export const listRuns = () => api<RunSummary[]>('/api/runs');
export const getRun = (id: string) => api<Run>(`/api/runs/${encodeURIComponent(id)}`);
export const createRun = (brief: Brief) =>
  api<Run>('/api/runs', { method: 'POST', body: JSON.stringify(brief) });
export const cancelRun = (id: string) =>
  api<{ id: string; status: string }>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
export const exportHref = (id: string) => `/api/runs/${encodeURIComponent(id)}/export`;

/** Assets are content-addressed. Anything not matching the hash shape is not ours,
 *  so refuse to put it in a src or href. Carried over verbatim from app.js. */
export function assetLink(url?: string | null): string | null {
  if (!url) return null;
  return /^\/assets\/[a-f0-9]{64}\.(png|svg|webp|jpg)$/.test(url) ? url : null;
}

/** Research sources come from a model in live mode, so restrict the scheme before
 *  rendering them as links. Carried over verbatim from app.js. */
export function safeLink(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'The server took too long to respond.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
