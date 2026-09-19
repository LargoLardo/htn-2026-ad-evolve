# Evolve — creative evolution lab

A runnable prototype for the pipeline in your [shared conversation](https://chatgpt.com/share/6aae325c-e5f8-83e9-9ee5-e5bd828a3aac): product brief → research → diverse ad genomes → rendered-image review → shortlist → optional pattern scoring → selection, crossover and mutation → final drafts.

**Start locally with Node.js 22+; no npm packages or API key are required for the demo.**

```powershell
npm start
```

Open **http://127.0.0.1:3000**. The prefilled PULSE brief is an illustrative product. Change the product, description, audience, goal, emotional priorities, number of rounds and population, then click **Start evolution**. Runs and assets are saved in `data/`. A copied `#run=…` URL reopens a saved experiment. Server restarts retain completed runs and mark interrupted runs as failed.

The interface includes finalist downloads, generation comparison, fitness history, inspectable genomes and parent links, research sources, event logs, saved experiments, cancellation, and JSON export. Fonts are stored locally with their licenses. The application has no third-party runtime JavaScript dependencies.

## What runs today

| Mode | Research and concepts | Images | Scoring |
| --- | --- | --- | --- |
| Demo (default) | Explicit brief-derived hypotheses, seeded gene pools, template copy | Local SVG storyboard illustrations | Transparent keyword/design heuristic; no neuroscience or measured emotion |
| Live + image review | OpenAI web search with checked source provenance; model-written genomes and copy | Generated square PNG drafts | Automated quality gates and separate image-quality / brief-alignment scores |
| Live + TRIBE | Same live research and generation | Actual generated PNG submitted to the worker | Frozen TRIBE features + published network maps; descriptive reference percentiles as a secondary criterion |

TRIBE v2 predicts cortical activity; it does not supply a validated joy/trust/curiosity/desire scorer. The prototype does not ship an emotion decoder or pretend that demo scores come from TRIBE. Its released code and weights have noncommercial licensing restrictions. See the [Meta model card](https://huggingface.co/facebook/tribev2) and [source-backed research notes](docs/TRIBE_RESEARCH.md).

This prototype creates **still-image ad drafts**. The active frozen reference uses a controlled, silent **10-second** lossless presentation. The archived 30-second worker and 5-second MPS experiment are incompatible with this reference. This is not generated motion video or a validated simulation of a feed impression.

## Enable live generation

Copy `.env.example` to `.env`, set `OPENAI_API_KEY`, and restart the server. Select **Models & reproducibility → Generation → Live**. This makes paid API calls. Credentials are read only by the server; no key is sent to the browser or saved in an exported run.

`OPENAI_TEXT_MODEL` and `OPENAI_IMAGE_MODEL` are configurable. The supplied defaults use the documented Responses/web-search and Images APIs. An API key does not guarantee access, quota, or availability. A provider failure stops the run with an error; there is no silent demo fallback. Documentation: [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [image generation](https://developers.openai.com/api/docs/guides/image-generation).

The active live scorer reviews **rendered images** for quality, copy accuracy and brief alignment. Optional TRIBE scoring uses a fixed reference and published cortical network maps, with descriptive percentiles as a secondary ranking signal. See [experimental/README.md](experimental/README.md) for setup, score interpretation and the speed/cost tradeoff. It needs no decoder training.

**OASIS extraction, decoder training and local model downloads are paused.** The 60 cached feature vectors, fitted pilot decoder and partial downloads are preserved as experimental artifacts. Training commands require an explicit future opt-in; automatic training after extraction is disabled. Historical results and methods remain in [training/README.md](training/README.md).

## The implementation

| File | Responsibility |
| --- | --- |
| `server.mjs` | Loopback HTTP API, input limits, two active runs, cancellation, persistence, static assets |
| `lib/evolution.mjs` | Seeded crossover/mutation, elites, diverse selection, fitness, caches and orchestration |
| `lib/providers.mjs` | Offline demo and live research, concept, image and TRIBE provider calls |
| `public/` | Responsive vanilla JavaScript creative lab |
| `experimental/build_reference.py` | Builds a label-free reference from already-cached features |
| `lib/neural-scorer.mjs` | Frozen-reference network-pattern comparison with strict feature compatibility |

The API exposes `GET /api/config`, `GET/POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, and `GET /api/runs/:id/export`. Runs contain the brief, research provenance, every generation, parent IDs, mutations, media hashes, scoring metadata, final candidates, events and counts. Node listens on loopback only. This is a local prototype, not a hosted multi-user service.

## Speed and verification

The implementation researches once, renders two candidates concurrently, screens before expensive work, retains an exploration slot **within** the shortlist, caches identical candidates, and batches worker requests. The GPU worker keeps loaded models resident, caches neural outputs by actual image bytes plus model/protocol revisions, and skips ASR for its silent-image stimulus. It processes GPU candidates serially; one HTTP batch is not vectorized GPU inference.

Live mode renders and reviews the population, then sends at most K candidates per round to TRIBE (default three), reusing exact-image features. Passing image reviews are preferred. If every image fails, the best provisional drafts are retained with visible failures so evolution can continue; no images are deleted. Finalists in TRIBE mode already have neural scores; the final round never expands the shortlist budget. Demo mode remains offline and uses clearly labeled design heuristics. Rendering more images can increase API cost; the savings apply to TRIBE evaluations and eliminated dataset extraction, not a measured end-to-end speedup.

```powershell
npm test
npm run check
python worker/test_worker.py
```

With the local server running, `npm run smoke` checks HTTP assets, input/origin boundaries, a complete offline experiment, export and persisted run data. It adds one demo run to the experiment history.

Original prototype verification: ten Node tests, Python calibration/boundary checks, and local HTTP smoke checks for creation, polling, asset delivery, export, persistence and input/origin validation. The final offline smoke run produced 24 concepts, 3 finalists, 8 SVG renders and 2 cache hits. Paid OpenAI requests remain unverified. The later Baseten experiment has executed real H100 TRIBE inference; see [its measured results and limitations](training/README.md). No controllable browser was available during prototype verification, so visual layout and browser interaction testing remain unverified; the frontend received syntax, CSS and markup checks.

The fast offline demonstration tests the workflow only; it is not a GPU benchmark. See [the full plan](docs/PLAN.md) for the fitness design, latency budget, staged implementation, extensions, and missing evidence.
