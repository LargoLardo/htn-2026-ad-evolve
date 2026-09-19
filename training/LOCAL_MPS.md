# Local Apple-GPU, 300-image direct-still experiment

> **Paused / archived experiment (2026-09-19).** The active app uses [training-free image review and network-pattern scoring](../experimental/README.md). Local model downloads and the 300-image job were stopped; existing features, decoder artifacts and partial downloads are preserved. The commands below describe historical methods. Download/extraction/trainer entry points now require deliberate per-command `EVOLVE_ENABLE_EXPERIMENTAL_TRAINING=1` to resume. Automatic `--train-when-complete` fitting is disabled. No training resumes when the app starts.

This is a **new protocol**, not more epochs on the 10-second decoder. TRIBE stays frozen; the laptop GPU extracts neural features, and the small ridge-regression decoder is fitted on the CPU afterward. Baseten is not contacted or reactivated.

The constant-average baseline ignores the image. For the original 40-image training set it always predicted **56.44 valence / 45.22 arousal** on the 0–100 scale. Lower held-out error than that baseline is a minimal sanity check, not proof of ad effectiveness. A new training split/population has its own training-only mean.

## Setup

From the repo root:

```sh
uv venv --python 3.11 data/venv-mps
uv pip sync --python data/venv-mps/bin/python training/requirements-mps.txt
.venv/bin/hf auth login
HF_HUB_DISABLE_XET=1 .venv/bin/python -m training.local_mps --download-only
```

The environment is isolated from `.venv` and ignored by Git. The pinned TRIBE, V-JEPA and Wav2Vec weights total approximately **7.17 GB**, plus dependencies. Hugging Face authentication is read from the credential store; credentials are never printed or written to artifacts. Silent-image inference does not use Word events, so only the pinned Llama config/tokenizer is downloaded, not its unused text weights. Downloads are resumable; `HF_HUB_DISABLE_XET=1` selects ordinary HTTP if the optional Xet transfer stalls.

## Protocol and compatibility

- `worker/affect_spec_mps_still5s.json`: **five-second** still presentation, silent audio, no speech recognition; **average all five predicted neural samples**. There is no five-sample burn-in, which would leave an empty vector. This is an experimental pooling choice and may be sensitive to onset/transient behavior.
- `worker/still_image.py` decodes the normalized PNG once, constructs a broadcast view of **64 identical RGB frames**, calls the unchanged V-JEPA processor/encoder once, aggregates tokens once, and repeats the embedding across **10 timepoints at 2 Hz**. The upstream four-second overlapping windows all contain the same pixels for a static image, including their clamped beginning. No reduced frame count, precision change, substituted embedding, or new image encoder is used.
- Actual Wav2Vec features of a five-second zero waveform are computed once per process and reused. Silence is **not** represented by fake zero embeddings. TRIBE's original layer aggregation, segmentation, padding, missing-text handling, cortical inference, and timestamps are retained.
- Every fresh process must pass a **first-real-image comparison** against the original lossless-MP4 route: video features, audio features, neural timestamps, and all `[5, 20484]` predictions. Shapes/finite values must match; numerical tolerance is `rtol=1e-5, atol=1e-5`, with exact equality and maximum error recorded. Failure stops extraction before saving the image. This one-time check creates an MP4; subsequent images do not. Passing numerical parity is not scientific validation of emotional response.
- The legacy 30-second and Baseten 10-second defaults stay unchanged. Feature/decoder hashes distinguish all protocols and the Apple execution backend. Never mix their features or weights.
- TRIBE's brain predictor, V-JEPA video encoder and audio encoder are explicitly routed to `mps`. The pinned neuralset schema only lists CPU/CUDA, so the local adapter sets the three extractor device fields after config validation and before any encoder is loaded.
- No silent CPU-kernel fallback is enabled. Unsupported MPS operations fail visibly. Encoder/output device assertions require MPS. Source hashes and package versions are included in runtime provenance; a changed adapter cannot silently resume an old feature directory.
- One image at a time, four CPU threads, and a 70% MPS recommended-memory allocation cap. This is a resource safeguard, not a proven peak-memory requirement. macOS and other apps still use unified memory.

## Prepare and benchmark

```sh
.venv/bin/python -m training.prepare_oasis \
  --spec worker/affect_spec_mps_still5s.json \
  --output data/datasets/oasis/manifest-still5s-mps-v5.json
.venv/bin/python -m training.make_pilot \
  --source data/datasets/oasis/manifest-still5s-mps-v5.json \
  --output data/datasets/oasis/subset300-still5s-mps-v5.json \
  --spec worker/affect_spec_mps_still5s.json \
  --group-balanced --train 210 --validation 45 --test 45
HF_HUB_DISABLE_XET=1 data/venv-mps/bin/python -u -m training.extract_local \
  --limit 1 --log-file data/local-mps-benchmark.log
```

The full 900-image source manifest retains the original grouped 606/137/157 split. **The selected experiment uses only 300 images: 210 train / 45 validation / 45 test.** Selection is frozen and label-blind: SHA256 ordering and round-robin across groups, taking one image from each group before additional images from the same group. No group changes split. The subset tool refuses to overwrite an existing manifest. The first call includes encoder loading and MP4 verification, so use subsequent images to estimate warm throughput.

## Archived extraction command

Keep the laptop plugged in and awake. This command inhibits idle sleep only while the job runs; closing the lid or explicit sleep can still interrupt it.

```sh
caffeinate -i env HF_HUB_DISABLE_XET=1 \
  data/venv-mps/bin/python -u -m training.extract_local \
  --manifest data/datasets/oasis/subset300-still5s-mps-v5.json \
  --limit 300 --log-file data/local-mps-still300.log
```

After a deliberate opt-in, rerun to resume completed images. Fitting no longer starts automatically; it requires a separate archived trainer invocation. A local lock prevents two extractor jobs from starting on the GPU at once. It checks AC power between images and stops safely if unplugged. It does not fabricate missing features or train an incomplete dataset. Optional `--max-minutes 60` stops between images after an hour of inference; `--limit N` caps new images for that invocation. Neither limit includes initial model downloads/loading or interrupts an in-flight image. `tail -f data/local-mps-still300.log` shows progress and errors. Allocator pages are retained between images and cleared every 25 images, while full video hidden states are released after each aggregation.

Results:

- `data/features/oasis-still5s-mps-v5/`: per-image real features and provenance.
- `progress.json` in that folder: last completed image, time and MPS memory observation.
- `local-extraction-summary.json`: summary written on a normal completion/limit stop.
- `data/decoder/oasis300-still5s-mps-v5.npz` and `.json`: fitted head and held-out metrics, only after all **300 selected** images exist.

Training refuses to overwrite an existing decoder. If it is already fitted, inspect its report rather than repeatedly tuning on its test set. Part of the original test split was evaluated in the earlier pilot; this is not a wholly new independent benchmark. Independent ad ratings and a cheaper image-embedding baseline are still needed.

## Tests and current status

```sh
.venv/bin/python -m unittest training.test_training training.test_local training.test_still -q
data/venv-mps/bin/python -m unittest training.test_still_integration -q
.venv/bin/python worker/test_worker.py
node --test tests/*.test.mjs
```

2026-09-19 setup: Apple M4 Pro, 16 GPU cores, 48 GB unified memory. Gated Hugging Face access is verified; the isolated environment and 300-image manifest are ready. **29 lightweight tests and two pinned-runtime integration tests pass.** The latter confirm exact RGB equality at all sampled MP4 timestamps, real silent-audio sample values, and that the actual TRIBE brain network accepts direct TimedArrays and returns finite `[5, 20484]` predictions. That brain contract test used synthetic sensory arrays and saved no dataset features or scores. Encoder downloads and the 300-image job were subsequently stopped at the user’s request. Mandatory real-image parity verification still applies if extraction is deliberately resumed. **Full local image-to-TRIBE inference, measured warm throughput, and decoder quality remain unverified.**
