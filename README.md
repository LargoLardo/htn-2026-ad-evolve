# Evolve — image and video ad evolution

Generate ad takes, review the actual media, then evolve the strongest takes using Percept's published TRIBE scoring method. Images use OpenAI image generation; videos use **Seedance 2.0 through Pika**. Research, concept writing and media review use OpenAI.

## Run locally

Requires Node 22+ and FFmpeg. No npm dependencies are needed.

```sh
cp .env.example .env
# Set credentials and the updated TRIBE worker endpoint in .env.
npm start
```

Open http://127.0.0.1:3000. The server binds to loopback only. It stores media, runs and caches under ignored `data/` directories.

Set `OPENAI_API_KEY` for research, images and review, `PIKA_API_KEY` for video generation, and `BASETEN_TRIBE_ENDPOINT` / `BASETEN_API_KEY` for neural scoring. Alternatively, `TRIBE_SCORE_URL` / `TRIBE_TOKEN` can address a worker implementing the same JSON contract. `FFMPEG_BIN` can override the FFmpeg executable. Configuration indicators only check settings; they do not wake a GPU or validate credentials.

**The GPU worker must be updated before live runs.** This change prepares the worker source; it does not deploy it, start model downloads or resume training. Older pooled-feature endpoints cannot provide these scores. See [worker setup and scoring](worker/README.md).

## Evolution loop

1. Choose image or video ads and optionally upload an original. Images accept PNG, JPEG or WebP. Videos accept MP4, 1–60 seconds. Uploads are limited to 50 MiB and 4096 pixels per dimension.
2. Research the brief once. If an original is supplied, review its observed copy, visual tags and audio transcript to ground new concepts.
3. Generate the population. Seedance videos use 720p, 4–15 seconds (default 10), and portrait, landscape or square format. Image takes are 1024×1024. The genome includes hook, visual, emotion, proof, CTA, palette, motion and audio.
4. Review actual pixels, copy, product visibility, supported claims and brief alignment. Video review samples six frames and transcribes audio with Whisper; it does **not** assess every frame or motion smoothness. All checks must pass and quality/alignment must each reach 60. The shortlist uses review scores and observed visual diversity.
5. Evaluate at most K shortlisted takes per generation with TRIBE. An uploaded original receives one additional baseline evaluation. Without an upload, the first shortlisted take becomes the original. That original stays fixed throughout the run.
6. Rank evaluated, reviewed takes by Percept's overall neural score. Review quality breaks exact neural ties. Retain the winner and use crossover/mutation to produce the next generation. Emotion sliders guide concepts; they do not change neural score weights.

If every review fails, retain a **nonempty provisional shortlist**. Failed checks remain visible and failed; provisional drafts compete only while no reviewed neural candidates are available. They are marked as needing review, including in the final results. A shortlist of one may produce fewer than three distinct finalists.

## Percept scoring

The implementation targets [Percept `worker/app.py` at commit `000f26d`](https://github.com/edrlu/Percept/blob/000f26d529e0b87b2478142bd8b5ebf40e44e313/worker/app.py). It uses the same Glasser parcel groups, original-media temporal normalization, parcel-balanced averages, four equally weighted families, clipping and NumPy/Python rounding. Offline tests compare complete outputs against five results produced by Percept's unmodified scoring functions.

Each image becomes a 10-second silent video during inference. Both media types then use Percept's shorter-side-256 preprocessing and TRIBE's video/audio/transcript event assembly. Full time series are scored; predictions are no longer pooled before normalization.

The four families are auditory engagement, language/message, attention/salience and visual/motion. Their average is a predicted cortical-response proxy, **not a validated emotion, preference or conversion score**. A score of 50 is the transform's zero-z midpoint; self-normalization does not guarantee exactly 50 after clipping. Scores from runs with different originals are not directly comparable.

The old keyword heuristic, OASIS reference percentiles and Yeo spatial-correlation scoring code have been removed. Historical saved runs keep their original scores and are labeled as historical. Fitted-decoder training remains [paused experimental work](experimental/README.md).

## Caching and cancellation

- Generation jobs and downloaded Seedance media persist. Cancelling stops local polling; it does not cancel a job already submitted to Pika. Retrying the same prompt/settings resumes the saved job. Completed jobs reuse their media.
- Review caches include the media bytes, brief, required copy, reviewer model and rubric version.
- Neural score caches include media bytes, endpoint, scoring contract and original-baseline identity. Baseline statistics and identities are checksum-validated. The worker separately caches full predictions, so a different original can reuse inference and recompute only the score.
- Completed media and evaluations remain on disk after cancellation. No new work is scheduled after cancellation is observed. A remote call already submitted may still finish or incur provider charges.

Seedance follows [Pika's model-specific REST specification](https://mcp.pika.art/llms/bytedance/seedance-2.0/text-to-video). OpenAI is retained for images, text and [audio transcription](https://developers.openai.com/api/docs/guides/speech-to-text). No Sora integration is used.

## Verification

```sh
npm run check
npm test
.venv/bin/python -m unittest worker.test_percept training.test_training training.test_pause
npm run smoke  # existing local server; no generation or GPU calls
```

Node tests require FFmpeg. Python tests need NumPy and Pillow plus the existing training test dependencies. `scripts/check-ui.py` optionally checks HTML/CSS using BeautifulSoup and tinycss2. Tests cover score parity, shared baselines, uploads, streaming ranges, video review, Pika job reuse/cancellation, cache corruption, evolution, and nonempty shortlist fallback. Paid generation and GPU inference need a separately configured live check; offline parity does not establish identical model predictions across runtimes or human-response validity.
