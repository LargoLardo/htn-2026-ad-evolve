# Percept-compatible TRIBE worker

`percept_worker.py` performs media inference; `percept_score.py` computes the exact score mathematics in NumPy. The versioned contract is `percept_spec.json`. The app and worker hash its exact bytes and reject mismatches. The checked-in Glasser atlas has its own checksum and [attribution](assets/ATTRIBUTION.md); no atlas download is needed at inference.

## Scoring definition

The parity target is [Percept's worker at `000f26d529e0b87b2478142bd8b5ebf40e44e313`](https://github.com/edrlu/Percept/blob/000f26d529e0b87b2478142bd8b5ebf40e44e313/worker/app.py).

For the original's time × 20,484 predictions, compute each cortical vertex's temporal mean and population standard deviation, with an SD floor of `1e-6`. For every take, subtract that original mean and divide by that original SD. These statistics stay fixed for all generations, even if the original loses.

At each time point, average normalized vertices inside each bilateral bare-name Glasser parcel, then average parcels equally inside each family. Match Percept's patterns:

| Family | Parcel patterns |
| --- | --- |
| Auditory / speech-music | A1, MBelt, LBelt, PBelt, A4, A5, STG*, STS* |
| Language / message | 44, 45, 47l, IFS*, IFJ* |
| Attention + salience | IPS*, LIP*, VIP, FEF, 6a, AVI, MI, FOP*, a24pr, p24pr, PFm, PGi, PGs, TPOJ* |
| Visual / motion | MT, MST, V4t, FST, LO*, V3CD |

Transform each family time point with `clip(50 * (1 + z / 2), 0, 100)` into float32 traces. Average over time and round each family to one decimal using Python/NumPy. Average the **already rounded** four family scores equally and round again for the overall score. This order, including clipping before temporal averaging, matters. The original generally centers near 50; clipping can shift its average. Takes may have different durations.

The seven Yeo networks are broad functional systems; Glasser defines finer cortical parcels (180 per hemisphere). Matching Percept requires its Glasser groups. Neither atlas alone validates an overall emotional-response score, and this cortical output excludes subcortical structures. Percept's static “high/medium” reliability labels are copied as descriptive metadata; they are not measured confidence or aggregation weights.

“Pooled” previously meant averaging temporal predictions into one vector before scoring. This path keeps time points until after original-relative normalization, parcel averaging and clipping, because pooling first would discard the original's temporal SD and change the result.

## Inference and deployment

The Baseten bundle in `deploy/baseten/` includes the whole `worker` directory via `external_package_dirs`, including the scorer, contract and atlas assets. Update an existing deployment with this source and its pinned requirements before connecting the app. Real image and video inference were verified on Baseten's `L4:2x24x96` instance on 2026-09-19. H100 provisioning stalled before Python startup in the tested account; the underlying platform cause was not exposed.

- Requires CUDA, the pinned TRIBE checkpoint and encoders, `hf_access_token` with gated model access, and FFmpeg/ffprobe.
- TRIBE's `get_events_dataframe` uses `uvx whisperx` for speech/text event assembly. `uv` is included in deployment requirements. First use can install WhisperX and download ASR/alignment weights; those runtime dependencies follow upstream TRIBE's behavior. Loading/deploying the worker can also download TRIBE/encoder weights. This must remain separate from local offline verification and the paused training jobs.
- Runtime caches use writable `/tmp` directories. The build installs checksum-pinned NLTK `punkt_tab` data and spaCy's `en_core_web_lg` model so transcript inference does not fail on missing language resources. Keep these dependencies even for image runs, since images use the same video event path.
- The tested instance has 96 GiB of host RAM and two 24 GiB L4 GPUs. Inference currently uses the default CUDA device; GPU memory is not pooled across devices. This configuration is a verified fallback, not a measured cost/performance optimum. Use deployment autoscaling (minimum zero replicas) to avoid an indefinitely idle worker, allowing for model and encoder startup time after scale-to-zero.
- Images become 10-second, 25-fps silent lossless MP4s. Both media types then use Percept's default shorter-side-256 FFmpeg preprocessing, `get_events_dataframe(video_path=...)`, and `predict`. Preprocessing failures are explicit rather than silently switching protocols.
- Model/code/encoder revisions are pinned and checked against the scoring contract. Runtime package versions are recorded and must match the original baseline. Identical score mathematics is tested; identical GPU predictions against Percept's deployment are **not** established. FFmpeg/ASR versions and hardware can also affect predictions.
- Legacy `features` and fitted-head `score` actions remain available only for archived experiments. The app exclusively calls `percept`. No fitted decoder is needed.

## Request contract

POST JSON to the Baseten prediction URL, or to a compatible endpoint configured as `TRIBE_SCORE_URL`:

```json
{
  "action": "percept",
  "contract_hash": "SHA256 of percept_spec.json",
  "baseline": null,
  "candidates": [{
    "id": "take-1",
    "media_type": "image",
    "media_hash": "SHA256 of the exact media bytes",
    "media_base64": "..."
  }]
}
```

`media_type` is `image` or `video`. Send 1–4 candidates; the app sends videos individually. With `baseline: null`, the first candidate establishes the original. The response contains `contract_hash`, `baseline`, and `results` with identities, scores and metadata. Send the entire returned baseline on subsequent calls. Its mean/SD array uses little-endian float64, with checksum and a compact sorted-JSON metadata hash. Raw baseline statistics are kept server-side in the evaluation cache; exported run summaries omit them.

`action: "health"` exposes `percept_contract_hash` and `percept_version`. A health request can wake the GPU deployment; app configuration checks never send one.

Raw full predictions are cached separately by media bytes, media type, scoring contract and runtime. The app caches final scores by media, endpoint, contract and original identity. Changing the original recomputes scores from worker-cached predictions. Existing pooled/OASIS caches are not used or deleted.

## Offline verification

`python -m unittest worker.test_percept` checks five complete outputs generated by executing Percept's unmodified scoring functions, bilateral parcel grouping, variable clip lengths, baseline integrity and cache/event handling. It does not load TRIBE weights. `tests/fixtures/percept-oracle.json` records the upstream commit and deterministic input seeds.

Rebuild only the small atlas artifact with `python scripts/build-glasser.py` (requires nibabel; downloads two annotation files, not models). The artifact merges left/right parcel names in the same order as Percept. Scores are research proxies; evaluate against audience ratings or ad outcomes before making efficacy claims.
