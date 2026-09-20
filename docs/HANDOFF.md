# Handoff

Start here. Two people can work in parallel from this point:

- **UI and UX** works in `web/`. Read [UI_HANDOFF.md](UI_HANDOFF.md).
- **Cloudflare port** works from `lib/` and `server.mjs`. Read [CLOUDFLARE_PORT.md](CLOUDFLARE_PORT.md).

The two do not overlap. The contract between them is the artifact JSON, which
is specified in the UI doc.

## What this is

Upload an ad. The system measures which parts of it are doing work and which
are dead weight, generates variations, scores them, and feeds the measurement
back into the next round.

Everyone else in this space generates ads or predicts attention. The claim
here is the loop: measure, steer, repeat.

## Running it

```sh
set -a && . ./.env && set +a && node server.mjs   # API on :3000
cd web && npm run dev                              # UI on :3001

npm test          # 41 tests, from the repo root
cd web && npm run build
```

`.env` needs `OPENAI_API_KEY`, `BASETEN_API_KEY` and `BASETEN_TRIBE_ENDPOINT`.
**The API server does not load `.env` itself.** Start it with the `set -a`
line above or every provider silently reports as not configured.

## The one result worth knowing

Two runs, same brief, same original, same seed. The only difference is whether
the measurement reached the prompt.

```
                    n   mean   median   max
loop disabled       9   13.1    12.6    23.5
loop closed         9   25.0    25.8    49.7
```

50 means parity with the uploaded original. The whole distribution moved, not
one outlier. That is the product working, and it is the thing to protect when
changing anything.

Caveats to keep attached: one run per condition, and this shows the system
steers toward its own metric, not that the ads sell more. Published work
testing TRIBE against real YouTube engagement found a correlation
indistinguishable from zero. **Claim regional attribution, never predicted
performance.**

## Parallelism, and the trap

Percept is the bottleneck: about **119 seconds per stimulus** on one L4.

**Several API keys do not help.** A key is only auth. The TRIBE model has to
be deployed in that workspace, so another account means another deployment of
the same model for the same effect.

**Replicas are the lever.** On the existing deployment:

1. `PATCH /v1/models/{model}/deployments/{deployment}/autoscaling_settings`
   with `min_replica` and `max_replica` set to N.
2. **Poll until `active_replica_count` actually reaches N.** Baseten scales
   reactively over about 60 seconds.
3. Only then set `PERCEPT_CONCURRENCY=N`.

Step 2 is not optional and skipping it is how this failed repeatedly. Firing
N concurrent requests at one replica queues them behind each other, and
Baseten's gateway closes a connection at around 420 seconds. With 4 replicas
up, a map goes from about 26 minutes to about 7.

**Never batch stimuli into one request.** The worker scores a batch serially,
so four images is one 476 second request and the gateway kills it. This cost
two entire runs before it was found. `batchSize` is 1 in `lib/providers.mjs`
and must stay 1.

**Scale `min_replica` back to 0 when finished.** A warm L4 bills continuously.

## The biggest available speedup, not yet done

TRIBE is a video model, so a still image is inflated into a **10 second video**
and scored frame by frame. That is where the 119 seconds goes.

The clip length is **not** in this repo's runtime path. It is hardcoded in the
worker that runs on Baseten:

```python
# worker/percept_worker.py
ffmpeg([... , *(['-t', '10'] if media_type == 'image' else []), str(infer_path)])
```

`lib/media.mjs` also carries `duration: 10` for images, but that is metadata
only and changing it does nothing. **Shortening the clip requires redeploying
the worker**, so this is not a local flag and not a five minute experiment.

It is also not free the way a pure frame count would suggest. The model
predicts one sample per TR, so a 10 second clip yields several samples that get
averaged, and a 2 second clip may yield one. Fewer samples means a noisier
estimate, not just a faster one. **3 or 4 seconds is a more defensible first
attempt than 2**, and whatever is chosen has to be validated against a known
10 second result on the same image before it is trusted.

Changing the stimulus invalidates every score already recorded, so add it as a
deployment parameter rather than editing the constant, and expect existing
baselines to need rebuilding.

Almost everything expensive downstream is gated on this: mapping every
candidate rather than two, scoring every candidate rather than three, and
per-round feedback.

## What is built

- Attention map, DeepGaze IIE, CPU, free, full resolution
- Impact map, one GPU pass per detected element of the ad
- The gap between them, per element, with labels
- Measured weaknesses fed back into the next round's prompt
- Lineage graph with pan, zoom and crossing minimisation
- Maps built by a run, streamed over SSE as they fill in

## What is not built, in priority order

1. **Per-round feedback.** The note is computed once from the original and
   reused for every round, so later rounds act on stale information. Measure
   each round's winner and accumulate the history into the note rather than
   replacing it: the model can then see what changed and what happened to it.
   Costs one map per round, which is why the clip length matters.
2. **The gate.** A round should end by asking who picks the parent nodes, with
   `auto` and `manual` policies as one code path and one flag, never two
   implementations. Manual lets a person pick parents, kill nodes and edit the
   note. Today the whole run is a single `async` function with no point at
   which it can stop, so this is the change that makes runs resumable, and
   therefore the change that makes the Cloudflare port mechanical.
3. **Score every candidate**, not the shortlist of three. Half the lineage
   reads `not scored` because a GPU pass is two minutes.
4. **Multi tenant storage.** D1 tables separated per account. Design for it
   from the start rather than retrofitting.
5. A run of five or more rounds, once the backend is stable.

## Things that look wrong and are not

- **Ads score below the uploaded original.** The node bar ticks the original
  at 50, and a clean ad landing left of it is expected. The metric is response
  magnitude, and clutter maximises it.
- **A child looks nothing like its parents.** Inheritance is over eight
  abstract traits, and the image is regenerated from scratch. No pixels are
  inherited.
- **Only four of eight nodes have descendants.** Only the parent pool breeds.
- **Areas of the map are unpainted.** No element was detected there, so
  nothing was measured. This is deliberate: the old grid implied the whole ad
  had been measured.

## Vocabulary

One word per idea, everywhere, including the prompt sent to the model.

round, traits, parent node, dead weight, carrying the ad, neutral.

Never: generation, genome, gene, "positive gap", or a signed number on
anything except the score.
