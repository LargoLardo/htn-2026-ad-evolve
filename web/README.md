# Advolve interface

The Next.js interface is the only frontend. It retains Advolve branding, light/dark themes, the experiment list and slide-over brief editor, and connects to the Percept/Seedance pipeline in the repository root.

Start the API from the repository root with `npm start` (port 3000). In this directory, run `npm ci`, then `npm run dev` (port 3001). Open http://127.0.0.1:3001.

For production: `npm run build`, then `npm start`. The API must run separately. Both default servers bind to loopback. `EVOLVE_API_ORIGIN` overrides the API address; use the same setting for build and start because asset rewrites are built into Next.js configuration.

`/api/*` uses a route handler that checks the browser origin before forwarding to the local backend. It preserves binary uploads, enforces the backend body limits, and retains export filenames. `/assets/*` proxies media with byte-range support for video seeking.

The brief selects image or Seedance video generation and optionally uploads an original. New runs always use live generation and Percept scoring. Historical runs stay readable. The inspector shows media review failures, provisional status, the fixed baseline and four neural family traces. Video controls are separate from the inspect button.

See [the main README](../README.md) for credentials, scoring, caching, limitations and tests. Model downloads and decoder training remain paused; no live inference is triggered by builds or tests.
