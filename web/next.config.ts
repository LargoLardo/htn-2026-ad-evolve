import type { NextConfig } from 'next';

// /api/* is proxied by the route handler at app/api/[...path]/route.ts, which
// has to strip the Origin header -- a rewrite forwards it and server.mjs 403s.
// /assets/* can stay a rewrite: it is only ever same-origin GETs from <img>,
// which carry no Origin header to begin with.
const API_ORIGIN = process.env.EVOLVE_API_ORIGIN ?? 'http://127.0.0.1:3000';

const nextConfig: NextConfig = {
  // Without this, loading the dev server over 127.0.0.1 instead of localhost
  // makes the HMR websocket handshake fail, and the app never hydrates -- the
  // page renders but nothing is interactive.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],

  async rewrites() {
    return [
      { source: '/assets/:path*', destination: `${API_ORIGIN}/assets/:path*` },
    ];
  },
};

export default nextConfig;
