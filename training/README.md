# OASIS affect decoder on Baseten

> **Paused / archived experiment (2026-09-19).** The active app uses [training-free image review and network-pattern scoring](../experimental/README.md). Local model downloads and the 300-image job were stopped; existing features, decoder artifacts and partial downloads are preserved. The commands below describe historical methods. Download/extraction/trainer entry points now require deliberate per-command `EVOLVE_ENABLE_EXPERIMENTAL_TRAINING=1` to resume. Automatic `--train-when-complete` fitting is disabled. No training resumes when the app starts.

This experiment fits **valence (pleasantness)** and **arousal (activation)** from frozen TRIBE predictions, using the real human ratings distributed with OASIS. It does not supply joy/trust/curiosity/desire labels. No trained weights are committed or fabricated.

For the separate **5-second Apple-GPU experiment**, see [LOCAL_MPS.md](LOCAL_MPS.md). It preserves this Baseten protocol and uses different manifests, caches and decoder artifacts.

Baseten runs the GPU feature extractor and, once trained, the live scorer. The small ridge-regression head trains locally on downloaded neural features. This is a substantive Baseten inference deployment; it does not claim to use Baseten Training Jobs. If the sponsor specifically requires managed training, confirm that requirement before the run and move the extraction/training driver into a Training Job container.

## What is ready

- `prepare_oasis.py`: pinned official archive, all 900 ratings, aspect-preserving 1024-square PNG preprocessing, 1–7 to 0–100 rating conversion, and reproducible train/validation/test splits. Themes, exact matches, and pHash near-duplicates are kept together. Review `cross_theme_similar_pairs` in the manifest if auditing splits.
- `extract_features.py`: one image per Baseten request, resumable local feature downloads, media/specification/checksum validation, and per-request timing. Supports an API key or an existing Truss browser login with automatic token refresh. It never uploads ratings to the scorer.
- `train_decoder.py`: training-only normalization, ridge alpha selection on validation, untouched test evaluation, mean-rating baseline, MAE/RMSE/Pearson/Spearman, versioned `.npz` weights and JSON provenance.
- `deploy/baseten/`: Truss GPU deployment using a versioned **10-second lossless RGB** silent-video protocol. TRIBE/code/encoder revisions are pinned in `worker/affect_spec.json`. Runtime model state stays resident; feature caches are separated by specification hash.
- `make_pilot.py`: label-blind budget subset: one image per distinct group, preserving original train/validation/test assignments.
- `package_decoder.py`: validates the resulting head and bundles it for redeployment.
- `score_image.py`: scores a local image with the deployed head, checking the returned protocol, decoder version, media identity and output range. One request, no automatic paid retries.

The app's original four-emotion UI and Node worker contract remain separate. This endpoint deliberately returns `affect: {valence, arousal}`. Connecting it to ad selection requires updating the app's labels/objective and provider endpoint; it cannot be enabled just by setting `TRIBE_URL`.

## Pilot result: trained, but not useful yet

The 60-image, 10-second-v3 pilot completed on 2026-09-19: **40 train / 10 validation / 10 test** from distinct groups. Validation selected ridge alpha 10,000. The frozen model failed to beat a training-mean baseline on both test outputs:

| Output | Test MAE, decoder | Test MAE, constant baseline | Pearson correlation |
| --- | ---: | ---: | ---: |
| Valence | 19.54 | 15.06 | -0.43 |
| Arousal | 9.86 | 8.62 | 0.53 |

Errors are on the 0–100 rating scale; lower is better. Ten test images give weak evidence, but these results do **not** support using this head for ad optimization. Positive arousal correlation does not override its worse absolute error. Do not flip valence or retune against this test set.

Actual weights: `data/decoder/oasis-pilot60-v3.npz`; provenance/metrics: the adjacent `.json`; per-image predictions: `.predictions.json`. All are ignored local artifacts, not committed model weights. The source manifest is `data/datasets/oasis/pilot60-10s-v3.json`; all 60 neural vectors are under `data/features/oasis-10s-v3/`. The packaged pair lives in `deploy/baseten/data/`.

The real Baseten scoring check passed after redeployment: fresh extraction of image I174 returned exactly the local head's valence 61.53585 and arousal 41.77861, in 20.36 seconds end-to-end. This checks deployment consistency, not model accuracy. The deployment was then explicitly deactivated and verified **INACTIVE with zero replicas**. The watcher and local shutdown guard were stopped. Roughly **$6.50** is a conservative whole-session compute estimate, rounding up to one hour at the listed H100 rate and counting build time. The billing API still reported stale zero-minute usage at shutdown; this estimate is not a settled bill or proof of free usage.

macOS matrix multiplication emitted floating-point warnings despite finite outputs. Independent non-BLAS contractions reproduced all validation trials within 5e-12 MAE and saved predictions within 1e-12 points. The implementation now uses those explicit contractions and passes a wide-vector numerical test. The original trained artifact, chosen alpha, splits and test results were **not** changed.

Next scientific steps: more training groups, a cheaper image-embedding baseline using the same splits, and a new independent ad-rating evaluation. This pilot does not isolate whether limited data, representation, exposure duration, or model choice caused poor performance. It does not establish that TRIBE adds predictive value.

## 1. Local environment and dataset

Run commands from the repository root. These steps have already been performed in the prepared workspace; they also reproduce it on another machine.

```sh
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r training/requirements.txt
.venv/bin/python -m training.prepare_oasis --download
.venv/bin/python -m training.check_setup
```

The official archive is about 92 MB and stays under ignored `data/datasets/oasis/`. Images are normalized in memory during preparation and extraction, so 900 upscaled PNGs are not stored. The importer reads only `OASIS.csv` and its corresponding images; it does not unpack arbitrary ZIP paths. Manifest regeneration refuses to replace a different experiment split.

Preparation creates `data/datasets/oasis/manifest-10s-v3.json`. This file preserves the archive hash, image hashes, original ratings, rater counts, source attribution, grouping, splits, and preprocessing version. Copy it alongside the ZIP to transfer an experiment. Dataset files, credentials, features and trained weights are excluded from Git. Legacy lossy-video features/manifests remain separate and cannot be used with this protocol.

## 2. Account steps you must do

1. Activate Baseten hackathon credits and enable deployment billing. Baseten may require a payment method even after login succeeds; contact the sponsor if the hackathon credit arrangement should waive this. Use Truss browser login or obtain a Baseten API key with deployment/inference access.
2. Request/accept access to [Llama 3.2-3B](https://huggingface.co/meta-llama/Llama-3.2-3B). Create a Hugging Face read token belonging to that account.
3. In [Baseten Secrets](https://app.baseten.co/settings/secrets), create `hf_access_token` with that Hugging Face token.
4. Authenticate locally with `uvx --python 3.11 truss login`. Use the interactive login; do not paste credentials into chat or commit them.

The reviewed TRIBE release and weights use CC-BY-NC-4.0. Review the upstream and dataset terms for your intended use; this setup does not grant commercial rights.

## 3. Deploy the feature extractor

The config requests **one H100**, with one prediction running at a time. That is an initial engineering choice, not a measured minimum. Check credit balance and hardware availability. The account's instance-price API returned $0.10833/minute (about $6.50/hour) on 2026-09-19; confirm current pricing before a new run. Change `resources.instance_type` to `A100:12x144` if using an available 80-GB A100 instead; benchmark before downsizing.

This command provisions billable GPU infrastructure:

```sh
uvx --python 3.11 truss push deploy/baseten --watch
```

Watch build/load logs. The first deployment downloads the pinned checkpoint and encoder snapshots. TRIBE dependencies use Python 3.11 and PyTorch 2.6.0. A successful local dependency resolution is not proof of a successful GPU build or inference; any upstream integration failures must be resolved from the deployment logs.

`--watch` creates a development deployment and keeps it warm while the watcher is active. Stop the watcher and explicitly scale down/deactivate the deployment when finished to control spend. Use the endpoint URL printed by the push command; development URLs differ from published production URLs. Local config/bundle checks used Truss 0.18.30.

`requirements.txt` locks the resolved Linux dependency set; `requirements.in` contains the direct requirements. Regenerate deliberately with the command in the lockfile header. Library-version changes separate the GPU cache and are rejected if they disagree with an existing decoder's training features.

The tested development replica does not expose a writable `/cache/org`. The config uses `/tmp/evolve-huggingface` (including the Xet download cache) and `/tmp/evolve-tribe` instead. These caches survive an inference-server restart in the same replica, but not replica replacement. The loader also handles permission failures on a configured shared cache by falling back to ephemeral storage. Neuralset 0.0.2 rejects local paths in its repository validation; the adapter adds only the downloaded, revision-pinned encoder snapshots to its in-memory allowlist before constructing TRIBE. Transformers still loads the local pinned weights.

After deployment, set these **in your terminal environment**, keeping the key server-side:

```sh
export BASETEN_TRIBE_ENDPOINT='https://model-YOUR_ID.api.baseten.co/development/predict'
# Set BASETEN_API_KEY using your local secret manager or a hidden-input prompt.
```

The Python tools read environment variables and do not automatically load `.env`. If you use the provided `.env.example`, make a private `.env`, fill its two Baseten fields, and export it in your shell before running the tools. Never share that file.

Alternatively, reuse your Truss browser login without creating/copying an API key:

```sh
uv pip install --python .venv/bin/python -r training/requirements-baseten.txt
.venv/bin/python -m training.extract_features --truss-remote baseten --limit 1
```

Continue passing `--truss-remote baseten` on the benchmark and full extraction commands below. Set the endpoint as above. The explicit remote takes precedence over `BASETEN_API_KEY`; Truss retrieves credentials from its credential store and refreshes OAuth tokens per request. Credentials are never saved in dataset artifacts. This authentication path is unit-tested and verified against real Baseten inference.

## 4. Verify one image, benchmark ten, then extract all

These commands make paid inference requests:

```sh
.venv/bin/python -m training.extract_features --limit 1
.venv/bin/python -m training.extract_features --limit 10
```

Confirm the deployment returns finite features and inspect timing in `data/features/oasis-10s-v3/extraction-summary.json`. The limit caps **new requests for this invocation**; the second command adds up to ten features to the first. Requests use a stable shuffled order for a varied benchmark. Estimate remaining time as uncached images × measured warm seconds/image, allowing for preprocessing and network overhead. Requests remain serial; there is no GPU batching.

Measured H100 benchmarks: original lossy presentation first call 177 seconds; a second lossy extraction 144 seconds. Lossless presentation took 48 seconds on the first image and 47/45 seconds on two subsequent images. These are a small sample, not a broad performance guarantee. At roughly 46 seconds/image, the full 900 would take about 11.5 hours (~$75 of GPU time before credits/startup).

The original video encoder used 4-second clips sampled every 0.5 seconds: 60 overlapping windows for 30 seconds. Lossy compression made all 60 decoded inputs distinct. Lossless RGB allows `worker/clip_cache.py` to reuse exactly matching V-JEPA inputs; the 30-second benchmark recorded 59 hits, 1 miss and 1 verification forward. Before reusing a new image's cached result, a fresh GPU forward must be bit-identical (`torch.equal`).

At the user's request, the current **v3 protocol presents each image for 10 seconds**, producing 20 overlapping video windows. Silent audio processing and TRIBE temporal prediction are retained. Pooling still discards the first five neural samples, leaving five samples rather than 25; the quality impact needs evaluation. The 10-second features and decoder must not be mixed with either 30-second protocol. The original four-emotion standalone worker retains its legacy default; this change applies to the Baseten affect-decoder experiment.

The first 10-second H100 extraction took **20.36 seconds** end-to-end. Its actual neural shape was `[10, 20484]`, with 19 exact-input cache hits, 1 miss and 1 verification forward. All 59 subsequent pilot requests completed without retries or whole-image cache hits, averaging **18.62 seconds** (17.85–21.27 seconds). This is roughly 2.3–2.6× faster than the measured 43–48-second lossless 30-second calls, but the shorter exposure also changes the features; it is not an accuracy-preserving optimization. At this rate, 900 uncached images would take roughly 4.7 GPU hours (~$30 before credits/startup), outside this experiment's $10 cap.

Once runtime and cost fit your remaining budget:

```sh
.venv/bin/python -m training.extract_features
```

Interrupting is safe for completed local results; rerun the same command to resume. There are no automatic paid retries. Each result is a local `.npz` pooled vector and `.json` metadata file. Corrupt or incompatible cached results stop the run instead of silently reusing them. A cancelled remote GPU operation may still finish; avoid assuming client cancellation stops billing immediately.

The configured `/tmp` replica caches are ephemeral. Baseten `/cache/org/`, when available, is also **not durable artifact storage**. The downloaded local feature directory is the training input; back it up with the dataset manifest. Raw time-series predictions remain in the GPU worker's cache and are not part of the downloaded pooled-feature bundle.

### Budget-limited pilot

The current experiment has a $10 total GPU cap, so it uses 60 images (40 train / 10 validation / 10 test), one per distinct group. Selection is fixed by seed and IDs, without consulting ratings or neural features. This is a feasibility experiment; ten test images do not establish robust emotion prediction or ad transfer.

```sh
.venv/bin/python -m training.make_pilot
.venv/bin/python -m training.extract_features --truss-remote baseten --manifest data/datasets/oasis/pilot60-10s-v3.json
.venv/bin/python -m training.train_decoder --manifest data/datasets/oasis/pilot60-10s-v3.json --output data/decoder/oasis-pilot60-v3.npz --version oasis-pilot60-valence-arousal-v3
```

Keep the pilot manifest frozen. Completed pilot features are also reusable when extracting the full 10-second-v3 manifest. No decoder training starts until every image in the selected manifest has a real feature vector.

## 5. Fit and evaluate

The trainer requires all manifest items to have real features. It refuses partial datasets, overlapping groups/media between splits, incompatible feature versions, and overwriting a decoder artifact.

```sh
.venv/bin/python -m training.train_decoder
```

Outputs:

- `data/decoder/oasis-10s-v3.npz`: fitted weights, training mean/scale, intercept.
- `data/decoder/oasis-10s-v3.json`: version, feature provenance, split counts, validation search, held-out test metrics and baseline comparison.
- `data/decoder/oasis-10s-v3.predictions.json`: per-image predictions for analysis.

The selected model is frozen after validation; test labels never affect weights or alpha selection. Keep the test report for the final evaluation, rather than tuning repeatedly against it. A higher Pearson/Spearman correlation is better; a lower error than the constant baseline is a minimal sanity check, not proof of useful ad optimization. No per-item confidence is estimated.

Before claiming TRIBE adds value, compare a head trained on cheaper image embeddings using the same splits. Before driving ads, collect independent human ratings on ads and evaluate transfer. OASIS is a general-image dataset, and its ratings were not collected under our exact 10-second video exposure. Those checks and an image-embedding baseline are not implemented here.

## 6. Bundle and serve the real decoder

```sh
.venv/bin/python -m training.package_decoder data/decoder/oasis-pilot60-v3.npz
uvx --python 3.11 truss push deploy/baseten --watch
```

Bundling writes ignored `deploy/baseten/data/decoder.npz` and `decoder.json`. Do a full push after adding them; the Truss watcher does not synchronize changes under `data/`. Publishing later uses `truss push deploy/baseten --promote` and creates a production deployment.

The command above uses the completed pilot artifact. Substitute the full-dataset artifact only after actually training it. The task's development endpoint is currently **deactivated**; pushing again restarts billable infrastructure. Do not restart it just to inspect local results.

Prediction requests use a shared contract:

```json
{
  "action": "score",
  "decoder_version": "oasis-pilot60-valence-arousal-v3",
  "candidates": [{"id": "ad-1", "png_base64": "...", "media_hash": "SHA256_OF_PNG"}]
}
```

Use the exact preprocessing in `worker.affect_decoder.normalize_image` before computing the hash. `action: features` returns portable little-endian float32 feature bytes plus a checksum and spec hash. `action: score` returns `affect.valence` and `affect.arousal` on the 0–100 rating scale, `confidence: null`, and provenance. Scoring refuses to run until a compatible head exists. `action: health` reports whether a head is loaded; calling it can wake an idle GPU deployment.

For an image on disk, the client handles preprocessing and request validation:

```sh
.venv/bin/python -m training.score_image path/to/ad.png \
  --truss-remote baseten --endpoint "$BASETEN_TRIBE_ENDPOINT" \
  --decoder-version oasis-pilot60-valence-arousal-v3
```

Use the deployed artifact's exact version, not the pilot version if you trained a different head. This command makes a paid inference request and may wake an idle GPU.

When wiring ad fitness, use a desired arousal target rather than assuming maximum activation is always desirable. Pleasantness, trust, purchase desire and effectiveness are different outcomes.

## Local checks

```sh
.venv/bin/python -m unittest training.test_training -v
.venv/bin/python worker/test_worker.py
node --test tests/*.test.mjs
```

The numerical tests use temporary synthetic fixtures only. They establish code behavior, not scientific validity, and never leave a usable-looking fake head in `data/decoder/`. Real deployment/extraction and held-out pilot results are reported separately above; ad transfer and comparative value over image embeddings remain unverified.

Status on 2026-09-19: 900 official OASIS images prepared into 606 training / 137 validation / 157 test images, with 248 disjoint groups. Nineteen training/authentication/transport/cache/protocol tests, the existing Python calibration test and ten Node tests pass. The Baseten H100 deployment builds, loads the pinned models, and returns real finite 20,484-dimensional neural features.

Baseten browser login and gated Hugging Face access are verified. After billing was enabled, model `qvm68v9q`, development deployment `q88x7vd`, was created. The original cache-permission and neuralset local-snapshot validation issues were fixed. The 30-second pilot was stopped when the user requested 10 seconds; completed features remain archived separately. The 10-second pilot is complete, its real fitted head is bundled, and remote scoring verification passed. The deployment was deactivated around 18:45 UTC on 2026-09-19 and verified with zero replicas; the local safety guard was stopped after verification, ahead of its 19:12 UTC deadline. No provider-enforced spending limit was installed. Any future run needs a new spending guard and explicit shutdown.

Sources: [OASIS](https://www.benedekkurdi.com/#oasis), [TRIBE release](https://github.com/facebookresearch/tribev2), [Baseten custom Model](https://docs.baseten.co/development/model/model-class), [Truss push](https://docs.baseten.co/reference/cli/truss/push), [GPU resources](https://docs.baseten.co/deployment/resources), [runtime caching](https://docs.baseten.co/development/model/runtime-caching).
