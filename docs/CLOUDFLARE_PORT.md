# Porting Advolve to Cloudflare

Written against the tree at `feat/attention-impact-maps`. This is a conversion
plan, not a record of work done. Nothing in it has been built.

## What the thing actually is today

One Node process (`server.mjs`, 243 lines) that is simultaneously the API, the
job runner and the asset store. It shells out to FFmpeg for all media work and
to a separate Python interpreter for DeepGaze. State is the filesystem:

```
data/runs/<uuid>.json        one document per run, rewritten atomically
data/assets/<sha256>.png     content addressed media, plus a sibling .json
data/maps/<sha256>-maps.json map artifacts, plus -attention.png
data/evaluation-cache/       provider response cache
```

Two long jobs exist. An evolution run is about 25 minutes, dominated by Percept
calls at roughly 119 seconds each. A map build is one call per occluded region.
Both currently live in the memory of the one Node process and die with it, and
neither can be paused or resumed, which is the single biggest obstacle to this
port and also to the product.

Two changes to the pipeline are decided and should land before or alongside the
port, because they change the cost model the architecture has to serve:

- **Occlusion is per detected object, not per grid cell.** The vision model
  returns up to 12 labelled boxes, each is occluded once, so a map is about 13
  calls rather than 37. Each pass hides a whole real thing, so the signal is
  large, and the result is directly readable as "the headline is dead weight"
  rather than as an average over cells.
- **A round ends at a gate** with two policies, auto and manual. Auto resolves
  immediately and is today's behaviour. Manual waits for a human to choose
  parent nodes, kill nodes and edit the note sent to the next round. One code
  path, one flag, never two implementations.

## Portability, module by module

Measured by what each file imports, not by intent.

| module | lines | ports as | why |
| --- | --- | --- | --- |
| `lib/grid.mjs` | 195 | **unchanged** | Pure. Arrays in, arrays out. No `fs`, no `child_process`. Holds cell geometry, sliding windows, accumulation, normalisation, gap, element scoring, impact notes |
| `lib/scoring-contract.mjs` | 42 | unchanged | Only `node:crypto` `createHash`, available under `nodejs_compat` |
| `lib/maps.mjs` | 75 | unchanged | Orchestration only; calls the two builders |
| `lib/impact-map.mjs` | 146 | **one function** | Every FFmpeg call is inside `maskCell`. Everything else is arithmetic and `fetch` |
| `lib/attention-map.mjs` | 55 | **one function** | The entire Python subprocess is inside `buildAttentionMap`. Its JSON contract is the seam |
| `lib/providers.mjs` | 377 | mostly unchanged | Already `fetch` to OpenAI and Baseten. Only the cache layer touches `fs` |
| `lib/evolution.mjs` | 408 | logic unchanged | Pure genetics. The `update()` persistence callback is the only thing to rehost |
| `lib/media.mjs` | 104 | **rewrite** | FFmpeg and `fs` throughout: ingest, inspect, normalise, frame sampling |
| `lib/run-maps.mjs` | 114 | **rewrite** | In-memory `Map` of jobs plus `fs` writes. Needs durable state |
| `server.mjs` | 243 | **rewrite** | `node:http`, static file serving, in-process job registry |

The two "one function" rows are deliberate. `maskCell` and the DeepGaze exec
were isolated when they were written precisely so the port would not have to
find FFmpeg calls scattered through the codebase.

## Target architecture

```
Browser
  |
  v
Worker (Hono or plain fetch handler)          <- API, SSE, auth
  |-- R2            advolve-assets            <- PNG/MP4 bytes by sha256
  |-- D1 or DO      run documents             <- see "state" below
  |-- Queue         advolve-percept           <- one message per stimulus
  |-- Workflow      map-build, evolution-run  <- durable multi step jobs
  |-- Images        binding                   <- replaces FFmpeg drawbox/scale
  `-- fetch         Baseten (TRIBE + DeepGaze), OpenAI
```

### Media: FFmpeg to Images binding

Three FFmpeg uses, in order of difficulty.

1. **Occlusion masking** (`lib/impact-map.mjs`, `maskCell`). Today:
   `drawbox=x:y:w:h:color=gray:t=fill`. Becomes `env.IMAGES.input(bytes)` with a
   grey rectangle drawn over the region, then `.output()`. This is the easy one
   and it is the only FFmpeg call the map pipeline makes.
2. **Ingest normalisation** (`lib/media.mjs`, `ingestMedia`). Today re-encodes
   everything to `rgb24` PNG so the content hash is stable across input formats.
   Becomes an Images transform to PNG. Note the hash changes when the encoder
   changes, which orphans existing artifacts, so plan a rehash or accept a
   one-time break.
3. **Video frame sampling** (`lib/media.mjs`, `reviewMedia`). Six frames plus an
   audio transcript. The Images binding does not do video. Either keep video on
   a container, or drop video support in the Worker build and keep images only.

`inspectMedia` parses FFmpeg stderr for dimensions and duration. For images,
read the PNG/JPEG header directly; there is no need for a media toolchain to
learn a width.

### DeepGaze: not a Worker

Python Workers are Pyodide, so a package needs a pure Python or PyEmscripten
wheel. Torch has neither. DeepGaze IIE therefore moves to Baseten alongside
TRIBE and is called over `fetch`.

`buildAttentionMap` already returns a fixed JSON contract
(`{ map, width, height, source, provenance }`), so only the transport inside
that function changes. Keep `js_round` in the Python side: it exists so the
Python cell edges agree exactly with `Math.round` in `lib/grid.mjs`, and if the
two disagree the attention and impact maps are reduced over different regions
and their difference is meaningless.

### State: what goes where

- **R2** for bytes. Key by `sha256` exactly as the filesystem does now, so the
  content addressing survives the move unchanged. Asset metadata can be R2
  custom metadata rather than a sibling `.json`.
- **Durable Object per run** for the run document. A run is a single document
  mutated by exactly one writer, appended to frequently during the 25 minutes
  it is alive. That is the DO shape, not the D1 shape. It also gives SSE
  subscribers a natural home: `lib/run-maps.mjs` already keeps a `listeners`
  set, which becomes the DO's WebSocket or SSE fan out.
- **D1** only if run listing and cross run queries are wanted. An index of
  `{ id, product, status, createdAt }` is genuinely relational; the run body is
  not.
- **Cache API or KV** for `data/evaluation-cache`. It is a pure function cache
  keyed by a content hash, with no invalidation story, so TTL semantics fit.

### The long jobs: Workflows

Neither job fits a request. Both fit `Workflow`:

- **Map build.** One `step.do()` per occluded object, so about 13 steps, each
  independently retryable. Step results are durable, so a half finished map
  survives a deploy, and a rehearsed demo can replay from completed steps
  instantly. `onProgress` in `lib/impact-map.mjs` becomes a write to the DO,
  which pushes to SSE subscribers.
- **Evolution run.** One step per stage per round. `lib/evolution.mjs` already
  calls `update(stage, message)` at exactly these boundaries, so the step
  boundaries are already marked in the source.

### The gate

At the end of each round the run stops and asks who chooses the parent nodes.
In auto it answers itself; in manual it waits for a person. On Workers that is
`waitForEvent`, and the pending decision lives in the run's Durable Object so a
browser can post to it and a reload can find it.

This is the reason the port is worth doing rather than a cost of it. Today the
whole run is one `async` function, so there is no point at which it can stop
and be resumed, and a human step is therefore impossible. Making the run a
sequence of durable steps delivers the pause as a side effect.

Only breeding blocks on the gate. Rendering and scoring for the round that has
already been generated continue, so the GPU does not sit idle while a person
thinks.

Percept calls go through a **Queue** with `max_concurrency` matched to the
Baseten replica count. This is the piece that fixes tonight's failure mode
properly: the gateway killed 476 second requests because four stimuli were
batched into one call. A queue with one stimulus per message and bounded
concurrency makes that structural rather than a constant someone can raise.

### SSE

`server.mjs` writes `text/event-stream` with a 15 second keep alive. Workers
support streaming responses directly, and a DO can hold the subscriber set.
The keep alive still matters.

## Order of work

1. R2 plus `lib/media.mjs` rewrite for images only. Everything else depends on
   assets existing somewhere.
2. Worker with the read routes and SSE, against R2 and a DO. No jobs yet.
3. DeepGaze onto Baseten, swap the transport inside `buildAttentionMap`.
4. Images binding for `maskCell`. The map pipeline now runs without Node.
5. Map build as a Workflow, Percept through a Queue.
6. Evolution run as a Workflow, with the gate as `waitForEvent`.
7. Video, or an explicit decision to drop it from the Worker build.

Steps 1 to 4 give a working maps product on Cloudflare. Steps 5 and 6 make it
durable rather than merely hosted.

## Things that will bite

- **Hash stability.** Any change to the normalisation encoder changes every
  `mediaHash`, which orphans every existing map artifact, since artifacts are
  keyed by the hash of the image they describe.
- **Grid parity.** `js_round` in `maps/saliency.py` exists to match JavaScript
  rounding. It must survive the move to Baseten.
- **Float determinism.** `statsF64` is a base64 float64 buffer used to validate
  that a baseline matches. Whatever serialises it must stay byte identical.
- **Request duration.** A single Percept call is about 119 seconds. Subrequest
  and wall clock limits apply per step, so keep one stimulus per step.
- **Scoring every candidate, not a shortlist.** Today only three takes per
  round reach Percept, which is why half the lineage has no score. Scoring all
  of them is the intent, and it multiplies the Queue's load by roughly three.
- **Nothing here removes the GPU dependency.** Percept is 119 seconds per
  stimulus on an L4 wherever it is called from. The one real lever is the
  stimulus itself: a still image is currently inflated into a 10 second video,
  about 250 identical frames, and every frame is scored. A shorter clip is
  close to a linear saving and is worth measuring before sizing anything here.
  Cloudflare changes where the orchestration lives, not what the physics cost.
