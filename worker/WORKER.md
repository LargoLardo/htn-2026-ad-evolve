# Optional TRIBE v2 GPU worker

> **Paused / archived experiment (2026-09-19).** The active app uses [training-free image review and network-pattern scoring](../experimental/README.md). Local model downloads and the 300-image job were stopped; existing features, decoder artifacts and partial downloads are preserved. The commands below describe historical methods. Download/extraction/trainer entry points now require deliberate per-command `EVOLVE_ENABLE_EXPERIMENTAL_TRAINING=1` to resume. Automatic `--train-when-complete` fitting is disabled. No training resumes when the app starts.

The Node prototype runs without Python. This worker is an opt-in bridge to the [official TRIBE v2 implementation](https://github.com/facebookresearch/tribev2), **not a supplied pretrained emotion model**. It uses `TribeModel.from_pretrained`, the upstream `get_audio_and_text_events(..., audio_only=True)` helper, and `predict(events=...)`. The emitted emotional values are estimates of human ratings from a separately fitted ridge decoder, never raw brain activation relabeled as emotion.

TRIBE code and weights are [CC-BY-NC-4.0](https://huggingface.co/facebook/tribev2). Resolve commercial licensing before using it for a commercial ad product. The text encoder requires gated Llama access. No GPU inference or paid OpenAI calls were available for this prototype's verification.

## Setup

Use a separate Linux GPU environment (or a GPU-capable WSL environment), Python 3.11+, the upstream package's pinned dependencies, FFmpeg, and access to the model weights and gated encoders. Follow upstream installation instructions; do not install their PyTorch stack into the web app. Pin a reviewed repository commit and download a pinned Hugging Face model snapshot containing `config.yaml` and `best.ckpt`.

Configure the worker process with environment variables (the Python worker does not automatically read `.env`):

| Variable | Meaning |
| --- | --- |
| `TRIBE_CHECKPOINT_DIR` | Local pinned model snapshot directory |
| `TRIBE_MODEL_REVISION` | Its 40-character Hugging Face revision hash |
| `TRIBE_CODE_REVISION` | Installed upstream code's 40-character Git commit hash |
| `TRIBE_DECODER_PATH` | Fitted `.npz` decoder; adjacent `.json` metadata required for `/score` |
| `TRIBE_CACHE_DIR` | Persistent feature/neural cache; default `data/tribe-cache` |
| `TRIBE_TOKEN` | Shared bearer token; required for non-loopback binding |
| `TRIBE_HOST`, `TRIBE_PORT` | Defaults `127.0.0.1`, `8091` |

Start with `python worker/tribe_worker.py`. Set the Node server's `TRIBE_URL`, matching `TRIBE_TOKEN`, and `TRIBE_DECODER_VERSION` to the decoder metadata's version. `GET /health` reports decoder configuration and whether the model has loaded. Its configuration status does not establish predictive validity. The model loads once on the first inference request, then stays resident. The worker processes requests serially to avoid GPU memory contention.

## What media is actually evaluated

`POST /score` accepts `{decoder_version, candidates:[{id,png_base64,media_hash}]}` and returns `{decoder_version,scores:[{id,media_hash,emotions,confidence,provenance,metadata}]}`. The Node provider reads and hashes the actual generated PNG; arbitrary media URLs and local paths are not accepted. PNG input must be 1024 square.

This prototype presents the image for **30 seconds**, at 25 fps, with a silent audio track. Its feature is the mean of predicted cortical vertices after the first five 1 Hz output samples. Protocol ID: `static-png-30s-silent-no-asr-25fps-1024-mean-after5-v1`. This timing/pooling choice is a hypothesis that must be validated with the same human-rating protocol. It is not evidence of an optimal ad exposure duration, a calibrated hemodynamic correction, or the response to a normal feed impression.

The upstream event helper's documented `audio_only=True` option retains video and silent audio while skipping speech recognition and text transforms. This avoids paying for WhisperX on a silent static ad or introducing hallucinated words. Despite the option's name, it does not drop the video event. No caption-only substitution or invented neural scores occur on failure. This bridge needs an actual GPU smoke test before operational use. A true video-only pipeline could improve throughput further, but requires an upstream-compatible adapter and ranking comparison before adoption.

## Obtain and fit the missing decoder

1. Collect consented target-audience ratings (0–100 for joy, trust, curiosity, and desire) for representative creatives using the same presentation. Average repeated human ratings per creative; retain the individual ratings separately for uncertainty analysis. No synthetic labels are provided.
2. Call `POST /features` with the same candidate payload, without `decoder_version`, to extract brain predictions without an emotion decoder. It returns local feature-file paths for research use. Raw predictions, pooled features, and alignment metadata persist in the worker cache.
3. Create a JSON manifest: `[{"features":"data/tribe-cache/neural/HASH.npz","product_group":"product-a","split":"train","ratings":{"joy":60,"trust":50,"curiosity":70,"desire":40}}, ...]`. Reserve complete products/campaigns and related creative families for validation. The tool rejects overlapping product groups and exact media hashes, but it cannot detect mislabeled near-duplicate families.
4. Run `python worker/calibrate.py labels.json data/decoder/emotions.npz my-decoder-v1`. It fits ridge regression using training-only normalization, then reports held-out mean absolute error and a constant-rating baseline. The decoder is only a research starting point: the CLI's tiny minimum sample checks are smoke-test constraints, not sufficient training or validation sizes.
5. Inspect held-out rank agreement, calibration, subgroup coverage, sample size, and whether it beats cheap image/text baselines. The tool does not declare scientific validity or reject weak models on your behalf. Keep a final untouched test set. Version any accepted head and configure it explicitly.

`confidence` is `null` and metadata states `uncertainty: not-estimated`; a regression output is neither an emotion probability nor a per-person prediction. Scores clip estimated ratings to 0–100. Fit quality and validation counts remain in the adjacent metadata. The worker validates model/code revisions, protocol, feature shape, and decoder version before emitting scores. It trusts the operator to install the checkpoint and code matching the declared revisions.

## Speed, cancellation, and limits

Neural cache keys include media bytes, checkpoint revision, code revision, and presentation protocol. Decoder changes reuse cached brain features. Goal weight changes happen in Node and do not rerun inference. Whole-media caching and a resident worker are implemented; incremental scene feature reuse, GPU batching across ads, surrogate training, and quantization are extensions.

The Node client has a 15-minute TRIBE deadline and propagates cancellation. Aborting the client prevents subsequent work in the web pipeline, but an already-running Python GPU call cannot be interrupted safely by this simple worker; it may finish and populate cache. Use process isolation or a worker job queue for hard cancellation and resource deadlines. Other limits: no automatic retries, no TLS inside this local worker, no authentication on its non-sensitive health endpoint, and no end-to-end latency/VRAM benchmark yet.

The implementation uses the actual image for features, but does not validate whether image generation rendered every word faithfully. Human review and downstream ad experiments remain necessary. See [research notes](../docs/TRIBE_RESEARCH.md) for scientific and licensing sources.
