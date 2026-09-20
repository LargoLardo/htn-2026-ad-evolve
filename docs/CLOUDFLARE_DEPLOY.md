# Cloudflare deployment

The implementation is in `cloudflare/`; Node local development still works.
The Next app builds with OpenNext. Its Worker forwards API, SSE and media
requests to a private API Worker through a service binding.

Local validation on 2026-09-20: 42 Node tests, 13 Cloudflare runtime tests,
and 2 real FFmpeg media-service tests passed. Both Worker bundles build.
A browser smoke test exercised the manual gate (including an empty selection),
and real local service bindings handled image upload and R2 asset retrieval.
No paid model calls were made during these migration tests. Remote Images
masking and a full hosted image/video run still require deployment validation.

## Put credentials here

Use the ignored **`.env.cloudflare` at the repository root** (mode 0600).
Copy `cloudflare/.env.example` there only if it does not already exist.
Never paste an API token into chat or commit it.

1. `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard → account home → account ID.
2. `CLOUDFLARE_API_TOKEN`: create a custom API token limited to that account.
   Grant **Workers Scripts Edit, Workers R2 Storage Edit, D1 Edit, Queues Edit,
   Images Edit, and Account Settings Read**. Workflows use Workers Scripts
   permission. If deploying a custom domain, also grant **Zone Read and
   Workers Routes Edit** for that zone. The UI may label Edit as Write.
   Enable Workers Paid, R2 and Images transformations in the dashboard before
   deployment. No R2 S3 access keys are needed.
3. `ACCESS_TEAM_DOMAIN`: Zero Trust team domain, e.g.
   `my-team.cloudflareaccess.com`, without `https://`.
4. `ACCESS_AUD`: Application Audience (AUD) tag of a Cloudflare Access
   self-hosted application protecting the entire frontend hostname.
5. `ADVOLVE_HOSTNAME`: optional custom hostname; leave blank for
   `advolve-web.<your-workers-subdomain>.workers.dev`.
6. `MEDIA_SERVICE_URL`: prediction URL of the separate Baseten media service
   below. Needed for video uploads/generation/review and attention maps.
   The existing Baseten key in `.env` is used unless `MEDIA_SERVICE_TOKEN` is set.

Tell the coding agent **“credentials added”**, your preferred hostname (or
“workers.dev”), and which email addresses should be allowed to sign in.
Those preferences are enough; do not send secret values. If Access is not set
up yet, account ID and API token are enough to start provisioning.

Configure Access in Zero Trust → Access → Applications. Use an **Allow** policy
for the intended emails; email one-time PIN is sufficient. Copy the AUD from
that application. For workers.dev, Cloudflare also provides an Access switch
under the Worker's domains/settings. Protect the full hostname including
`/api/*` and `/assets/*`. The API verifies JWT signature, issuer, audience and
expiry itself, so missing or invalid Access configuration fails closed.
Each verified user has a separate account namespace; shared team tenancy is
not yet implemented. Changing the Access issuer or user identity changes that
namespace and requires an explicit history import.

Token reference: [Cloudflare permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
Worker roles: [Cloudflare authorization](https://developers.cloudflare.com/workers/authorization/).

## Build, provision, deploy

From the repository root, with Node 22 or newer:

```sh
npm ci --prefix cloudflare
npm ci --prefix web
npm test
npm test --prefix cloudflare
npm run build --prefix cloudflare
npm run build:cloudflare --prefix web
node cloudflare/scripts/deploy.mjs check
node cloudflare/scripts/deploy.mjs provision
node cloudflare/scripts/deploy.mjs deploy
```

`check` is read-only and prints only whether settings are present. `provision`
creates/reuses the D1 database, private R2 bucket and neural Queue, writes an
ignored concrete Wrangler configuration and applies the account-scoped schema.
`deploy` also deploys the API, loads provider secrets from `.env` and
`.env.cloudflare` into **API Worker secrets**, builds and deploys the frontend.
The API has no public workers.dev URL. Provider keys never go into the browser
or frontend build. This script does not create Access allow policies.

Do not deploy raw `cloudflare/wrangler.jsonc` remotely: its database ID is a
placeholder for local testing. Generated `wrangler.deploy.json` files have real
resource IDs, are ignored, and are reused by operational Wrangler commands.

After signing in, `/api/config` reports provider readiness and `/api/account`
returns your application account namespace. Test an upload, then a two-round
run with manual selection. Reload while paused, pick a parent and resume;
confirm media, lineage, exports, maps and a video seek. Local automated tests
use mocked paid provider responses and do not prove live Baseten availability.

## Baseten media service

TRIBE remains the existing deployment with its unchanged neural contract and
10-second still-image protocol. Deploy the separate service:

```sh
truss push deploy/baseten-media --publish
```

Its `Model.load` loads pretrained DeepGaze IIE once per CPU replica. FFmpeg
inspects MP4s and returns the same six review frames and mono 16 kHz audio as
the local pipeline. DeepGaze uses the shared `maps/saliency.py`, including
uniform centerbias, float64 finalization and JavaScript-compatible grid edges.
It receives private media bytes, never fetches arbitrary uploaded URLs.
Set its prediction URL as `MEDIA_SERVICE_URL`, then rerun deployment to upload
that secret. Keep **min_replica=0** for this service and TRIBE when idle. This
package does not start local model downloads or any decoder training.

## Runtime and limits

- D1 is an account-filtered run/map index; full run documents live in SQLite
  Durable Objects, with chunked storage for large score histories.
- R2 keys start with the authenticated account ID. Media, evaluation caches,
  results and map artifacts stay private. Image uploads normalize via Images;
  images allow 20 MiB and MP4s allow 50 MiB / 1–60 seconds.
- Every neural Queue request contains exactly **one stimulus**. Default Queue
  consumer concurrency and `TRIBE_CONCURRENCY` are both **1**.
- Queue retries check actual Baseten replicas first. A sleeping deployment is
  woken without increasing min replicas. Raise concurrency only after polling
  `active_replica_count` to your target. Match the Queue's `max_concurrency`
  and Worker `TRIBE_CONCURRENCY`; restore min replicas to zero afterward.
- Workflow steps persist provider outputs. Render/review step names use the
  candidate ID so different parallel completion order cannot attach results
  to the wrong take during replay. Seedance job IDs are retained before polling.
- Manual selection waits natively for an event, up to 30 days. Decisions are
  saved before notification, idempotent, and must retain 1–4 valid parents.
  Only breeding waits; the preceding round has finished scoring.
- Per-round feedback is optional because each winner map adds one TRIBE pass
  per detected element. It accumulates measured notes before the next round.
- Images encoding can produce different content hashes than local FFmpeg.
  **Existing `data/` is untouched.** Do not re-encode old media when migrating
  history: preserve the original bytes, hashes, baseline, and contract.
- Do not change step names or the shared evolution algorithm while workflows
  are active. Drain/pause releases and use a versioned Workflow class for
  incompatible changes. Deploying a new implementation cannot repair or replay
  an old in-memory Node run.

## Local Worker development

Create ignored `cloudflare/.dev.vars` with `AUTH_MODE=local` and the required
provider keys. Local auth is permitted only for localhost/127.0.0.1 requests.

```sh
npm run migrate:local --prefix cloudflare
npm run dev --prefix cloudflare -- --port 8787
EVOLVE_API_ORIGIN=http://127.0.0.1:8787 npm run dev --prefix web
```

The Node development proxy is retained. Cloudflare's local Images emulator
has limited transform support: masking fidelity must be verified remotely.
Actual model timings still depend on provider startup and inference; the port
makes orchestration durable, not TRIBE itself faster.
