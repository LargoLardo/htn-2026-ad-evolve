# Experimental scoring without decoder training

The active app uses rendered-image review, optionally followed by a descriptive TRIBE pattern comparison. OASIS decoder fitting and local model downloads are **paused**. The 60 cached TRIBE vectors, old fitted decoder and incomplete downloads are preserved. No new model is trained by this workflow.

## What runs

1. Research the brief once and generate varied creative genomes.
2. Render the live population (two concurrent image jobs). A multimodal API reviews the actual PNG, transcribes visible text, and checks product depiction, copy readability/accuracy, supported claims and major rendering defects. It separately scores image quality and brief alignment. These are model judgments, not verified brand identity or human ratings. Emotional priorities inform the desired creative tone only.
3. Mark an image as passing only when every check passes and both rubric scores are at least 60. The primary visual score is their average. Prefer passing images. If every image fails, retain up to K provisional drafts (at least one for a nonempty reviewed population), prioritizing fewer failed checks/thresholds and then higher visual scores. Continue the run with their original failed checks still visible; never change them to passes. All candidates and their images remain saved regardless of shortlist selection.
4. For optional TRIBE scoring, shortlist the best K−1 visual scores plus one diverse candidate based on the reviewer's observed visual tags (Jaccard distance). With K=1, take the best visual score. Never exceed K, including the last round; small budgets can produce fewer than three finalists.
5. Request **features**, not a trained decoder's scores, from the existing GPU worker. Compare them locally to published cortical network maps and a fixed reference distribution.
6. Rank quality-approved and TRIBE-evaluated candidates by fixed five-point visual-score bands, then the selected network's percentile, then precise visual score. A neural score cannot beat a higher visual band. Without TRIBE, rank by visual score alone. A neural score never changes a failed check. Provisional drafts can become parents/results only when no passing, evaluated candidates are available. If any passing candidates exist in the archive, final selection excludes provisional drafts; otherwise the final results are explicitly marked as needing review. This fallback does not bypass malformed responses, mismatched media, cancellation or inference errors.

For 12 images and K=3 this caps neural evaluations at three per round before cache reuse, a 75% reduction versus evaluating all twelve. The prior app already shortlisted text concepts; this change improves **what** gets shortlisted and removes the dataset-extraction requirement. It does not speed up one TRIBE forward pass. Rendering/reviewing the entire population can increase image API cost and total latency. No end-to-end live speedup is claimed.

## Frozen network reference

`build_reference.py` reads the existing 60 `.npz` vectors and their verified metadata, without reading OASIS ratings or running TRIBE. Run it once if the local artifact is absent:

```sh
.venv/bin/python -m experimental.build_reference
```

It writes `data/experimental/oasis60-yeo7-v1.json` plus a SHA-256 sidecar. Existing references cannot be overwritten. To create another reference, use a new `--output` path and explicitly change `TRIBE_REFERENCE_PATH`. The generated reference stays in ignored local data; a fresh checkout needs the cached features or a copy of both reference files.

The small checked-in atlas asset comes from [Yeo et al. (2011)](https://doi.org/10.1152/jn.00338.2011), [CBIG's original release](https://github.com/ThomasYeoLab/CBIG/tree/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Yeo2011_fcMRI_clustering). Its immutable commit, checksum, citation and [MIT license](assets/CBIG-LICENSE.md) are retained. `lh_labels` and `rh_labels` each have 10,242 vertices; concatenating left then right matches [TRIBE's fsaverage5 surface projector](https://github.com/facebookresearch/tribev2/blob/af58661791a351a448a489042a28f6c37e1c14b7/tribev2/utils_fmri.py). No Percept source code was copied.

For each vertex, freeze the mean and standard deviation across reference images. Exclude atlas medial-wall and near-constant vertices; floor remaining scales at 5% of the median nonconstant standard deviation. Spatially correlate the standardized candidate vector with each binary Yeo network map over the retained cortex. Convert r to an empirical midrank percentile using the **same frozen** reference correlations. Neither another candidate nor a new generation changes those statistics. Source hashes, inference-library versions, execution settings and model/code/protocol revisions travel with the reference.

An example interpretation is “dorsal-attention-network pattern, 78th reference percentile.” This is neither 78% attention nor evidence that the ad is good. These are resting-state network maps, not Neurosynth task maps or trained emotion signatures. The reference consists of 60 general photographs, not representative ads. It includes former pilot train/validation/test vectors without using their ratings; it is **not** a new independent validation set. No significance test, calibrated uncertainty, emotional probabilities or conversion prediction is supplied.

A conservative heuristic marks a pattern outside the reference range when its standardized RMS exceeds max(5, three times the largest reference RMS). Such a pattern receives a neutral tie-break value and retains its descriptive scores for inspection. This rule is an engineering guard, not a validated out-of-distribution detector.

## Connect the existing feature worker

```dotenv
OPENAI_API_KEY=...
# Optional vision-capable model override; defaults to the text model.
OPENAI_SCREEN_MODEL=...
BASETEN_TRIBE_ENDPOINT=https://model-<id>.api.baseten.co/development/predict
BASETEN_API_KEY=...
TRIBE_REFERENCE_PATH=data/experimental/oasis60-yeo7-v1.json
```

Alternatively, `TRIBE_FEATURES_URL` is a full endpoint URL accepting the same `action=features` contract and optional bearer `TRIBE_TOKEN`. The legacy worker's path-only `/features` response is not compatible. `TRIBE_URL`, `TRIBE_DECODER_VERSION` and the old fitted decoder are no longer used by the app.

The existing Baseten deployment supports features already; no redeploy is necessary to use this client. Its feature protocol must match the cached **10-second lossless RGB protocol**, runtime versions and execution configuration exactly. The paused **5-second MPS/direct-still experiment is incompatible** and is rejected. Opaque RGB 1024×1024 PNGs are required so the displayed, reviewed and TRIBE-scored image pixels agree. Requests carry a maximum of four images per batch; the existing worker executes them serially.

Disk caches use actual image hashes plus reference hash for neural features; image-review caches also include the brief, intended copy, reviewer model and rubric version. Cached features are revalidated for checksums and protocol on every read. Configuration checks do not contact or wake the GPU endpoint. Paid live generation/review and a full new live evolution run have not been exercised for this change.

## Archived decoder experiment

The old pilot did not beat a constant baseline on either valence or arousal; see [the preserved report](../training/README.md). Its files are kept as research artifacts. Model-download and extraction/trainer entry points now refuse to run unless a future operator deliberately sets `EVOLVE_ENABLE_EXPERIMENTAL_TRAINING=1` for a specific command. `--train-when-complete` is disabled even with that opt-in; fitting must be a separate deliberate step. The web app never sets this variable.

## Verification for this change

- 24 Node tests pass, covering nonempty provisional fallback, recovery to passing drafts, quality gating, visual diversity, ranking, strict shortlist budgets, persistent caching, media/protocol validation, four-image worker batches and reference consistency.
- 32 Python tests pass, including pause guards and the preserved protocol/cache/decoder unit checks. Syntax checks and the HTTP demo smoke test pass.
- All 60 real cached vectors were checked against independent NumPy Pearson correlations across seven networks; maximum absolute difference was 6.5e-15. Rebuilding the reference reproduced its normalization exactly and its correlations within 2.5e-15; overwriting it was rejected.
- Local pattern mapping measured about **1.5 ms median / 2.3 ms p95** across 120 evaluations after loading the reference. This excludes TRIBE inference, API requests and image generation. The audit report is at `data/experimental/reference-verification.json`.
- No new GPU inference or model-weight downloads were needed. Paid live evolution and browser interaction were not exercised.
