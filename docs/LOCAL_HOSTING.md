# Local hosting

Advolve can run on your computer using `server.mjs` and the Next.js frontend.
The Cloudflare deployment is a separate hosting option. Both use the shared
evolution engine, media review and neural scoring contract in `lib/`.

Local hosting requires no Cloudflare account, Wrangler login, D1, R2 or Access
credentials. OpenAI, Seedance through Pika, and your TRIBE scoring endpoint
still provide remote generation and inference. This is not an offline model
installation.

## Setup

Install Node.js **22.9 or newer** (the startup scripts use
`--env-file-if-exists`), npm, and FFmpeg. Run commands from the repository root.
FFmpeg must be on `PATH`, or set `FFMPEG_BIN` to its absolute path in `.env`.
It is used for image uploads as well as video processing.

```sh
npm ci --prefix web
cp .env.example .env   # First setup only; preserve an existing .env
```

Edit `.env` with your own provider credentials:

| Setting | Used for |
| --- | --- |
| `OPENAI_API_KEY` | Research, concepts, image generation and media review |
| `BASETEN_TRIBE_ENDPOINT` and `BASETEN_API_KEY` | Neural scoring through the deployed TRIBE worker |
| `PIKA_API_KEY` | Seedance video generation; optional for image-only runs |
| `TRIBE_SCORE_URL` and optional `TRIBE_TOKEN` | Alternative to the Baseten scoring settings |

The scoring endpoint must implement this repository's current worker contract;
see [worker setup](../worker/README.md). `TRIBE_SCORE_URL`, if set, takes
precedence over the Baseten endpoint. Keep credentials in the root `.env`,
which Git ignores. They do not belong in browser environment variables.

## Start the app

Terminal 1, from the repository root:

```sh
npm start
```

Terminal 2, also from the repository root:

```sh
npm run dev --prefix web
```

Open **http://127.0.0.1:3001**. The API listens on `127.0.0.1:3000`; the UI
proxies `/api/*` and `/assets/*` to it, including uploads and video seeking.
Both servers bind to loopback. `npm start` loads `.env` automatically. Use
`npm run dev` for backend development with file watching; edits restart that
process, so prefer `npm start` during long runs.

To serve a production frontend locally, replace the second command with:

```sh
npm run build --prefix web
npm start --prefix web
```

The API still runs separately. To change its port, set `PORT` in the root
`.env`. Set the matching `EVOLVE_API_ORIGIN` in `web/.env.local`, for example
`EVOLVE_API_ORIGIN=http://127.0.0.1:3100`, then restart the frontend. Production
asset rewrites capture this address during the build, so rebuild after changing
it. Cloudflare build/deploy commands are not needed for these Node servers.

## Pipeline and saved data

Local runs support images and videos, original-media baselines, review,
shortlisting, neural ranking, crossover/mutation, lineage, cancellation and
JSON exports. Parent selection runs automatically. Durable manual round gates
and optional per-round map feedback are features of the Cloudflare backend;
the UI hides those settings when connected to the local API.

| Directory | Contents | Optional override |
| --- | --- | --- |
| `data/runs/` | Saved run JSON and results | None in the CLI |
| `data/assets/` | Uploaded/generated media and metadata | `EVOLVE_ASSETS_DIR` |
| `data/evaluation-cache/` | Reusable reviews, scoring results and Seedance jobs | `EVALUATION_CACHE_DIR` |
| `data/maps/` | Saved maps and attention images | `EVOLVE_MAPS_DIR` |

These directories are created as needed and ignored by Git. Keep them when
updating the app. Local data is separate from Cloudflare's account storage;
switching hosting modes does not migrate runs or media.

Keep the API process and computer awake until a run finishes. Completed runs
reload from disk after restart; interrupted runs are marked failed. Local
execution does not have Cloudflare Workflows' durable resume behavior.

## Optional attention and impact maps

The local maps pipeline uses FFmpeg for occlusion and a Python subprocess for
DeepGaze IIE. Install its dependencies in a separate Python 3.11 environment
only if you want to build maps locally:

```sh
python3.11 -m venv .venv-maps
.venv-maps/bin/python -m pip install \
  torch==2.6.0 torchvision==0.21.0 numpy==2.2.6 Pillow==11.3.0 \
  boltons==25.0.0 einops==0.8.1 \
  'clip @ git+https://github.com/openai/CLIP.git@d05afc436d78f1c48dc0dbf8e5980a9d471f35f6' \
  'deepgaze-pytorch @ git+https://github.com/matthias-k/DeepGaze.git@c7db17e2d1d7ea6468ffdee2cfaddf141095dcff'
```

Alternatively set `MAPS_PYTHON` in `.env` to an existing interpreter containing
these dependencies. First use downloads DeepGaze weights; subsequent uses reuse
its model cache. The local script uses CUDA when available, otherwise CPU
(including Apple silicon). Impact maps also call your TRIBE endpoint for the
occluded images. Maps currently apply to still images.

Local Node maps do not use `MEDIA_SERVICE_URL`; that setting belongs to the
Cloudflare media adapter. Starting the app or running the tests does not start
decoder training or download local TRIBE weights.

## Verification

```sh
npm run check
npm test
npm run build --prefix web
npm run smoke   # With the local API running
```

The Node tests use real FFmpeg processing and temporary local storage with
mocked paid providers. They exercise uploads, video ranges, two rounds of
evolution, the shared baseline, ranking, export and the frontend proxy without
paid generation or inference. The smoke check reads the API configuration and
run list and checks origin protection; it does not start a run.

If providers appear unconfigured, check the root `.env` and launch with
`npm start`; bare `node server.mjs` does not load that file. If the UI reports
that the API is unreachable, check that both processes are running and that
`EVOLVE_API_ORIGIN` matches the API's port.
