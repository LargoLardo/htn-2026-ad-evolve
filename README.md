# Evolve — creative evolution lab

A runnable prototype for the pipeline in your [shared conversation](https://chatgpt.com/share/6aae325c-e5f8-83e9-9ee5-e5bd828a3aac): product brief → research → diverse ad genomes → weighted screening → shortlist → rendering/scoring → selection, crossover and mutation → final drafts.

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
| Live + proxy | OpenAI web search with checked source provenance; model-written genomes and copy | Generated square PNG drafts | Same unvalidated text/genome heuristic |
| Live + TRIBE | Same live research and generation | Actual generated PNG submitted to the worker | TRIBE neural features plus **your separately fitted experimental emotion decoder** |

TRIBE v2 predicts cortical activity; it does not supply a validated joy/trust/curiosity/desire scorer. The prototype does not ship an emotion decoder or pretend that demo scores come from TRIBE. Its released code and weights have noncommercial licensing restrictions. See the [Meta model card](https://huggingface.co/facebook/tribev2) and [source-backed research notes](docs/TRIBE_RESEARCH.md).

This prototype creates **still-image ad drafts**. The optional TRIBE bridge presents those images as controlled, silent 30-second videos; that is a research stimulus protocol, not generated motion video or a normal feed-impression simulation.

## Enable live generation

Copy `.env.example` to `.env`, set `OPENAI_API_KEY`, and restart the server. Select **Models & reproducibility → Generation → Live**. This makes paid API calls. Credentials are read only by the server; no key is sent to the browser or saved in an exported run.

`OPENAI_TEXT_MODEL` and `OPENAI_IMAGE_MODEL` are configurable. The supplied defaults use the documented Responses/web-search and Images APIs. An API key does not guarantee access, quota, or availability. A provider failure stops the run with an error; there is no silent demo fallback. Documentation: [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [image generation](https://developers.openai.com/api/docs/guides/image-generation).

For actual TRIBE scoring, follow [worker/WORKER.md](worker/WORKER.md). It covers a separate GPU environment, pinned model/code revisions, feature extraction, human labels, decoder fitting, and `TRIBE_URL`/`TRIBE_DECODER_VERSION`. The Python worker must receive its environment separately; it does not load `.env` itself. TRIBE is available only for live PNGs and an explicitly configured decoder.

## The implementation

| File | Responsibility |
| --- | --- |
| `server.mjs` | Loopback HTTP API, input limits, two active runs, cancellation, persistence, static assets |
| `lib/evolution.mjs` | Seeded crossover/mutation, elites, diverse selection, fitness, caches and orchestration |
| `lib/providers.mjs` | Offline demo and live research, concept, image and TRIBE provider calls |
| `public/` | Responsive vanilla JavaScript creative lab |
| `worker/tribe_worker.py` | Optional resident TRIBE process and actual-media feature cache |
| `worker/calibrate.py` | Ridge decoder fitted from real labels, with held-out product groups |

The API exposes `GET /api/config`, `GET/POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, and `GET /api/runs/:id/export`. Runs contain the brief, research provenance, every generation, parent IDs, mutations, media hashes, scoring metadata, final candidates, events and counts. Node listens on loopback only. This is a local prototype, not a hosted multi-user service.

## Speed and verification

The implementation researches once, renders two candidates concurrently, screens before expensive work, retains an exploration slot **within** the shortlist, caches identical candidates, and batches worker requests. The GPU worker keeps loaded models resident, caches neural outputs by actual image bytes plus model/protocol revisions, and skips ASR for its silent-image stimulus. It processes GPU candidates serially; one HTTP batch is not vectorized GPU inference.

Default settings screen 24 concepts over three rounds. They shortlist at most nine candidate slots; unchanged winners reuse work. Proxy mode can render up to three additional archived finalists. In TRIBE mode, finalists already have actual-media scores, so no unscored concept can win. The final round evaluates at least three candidates even if you choose a smaller shortlist.

```powershell
npm test
npm run check
python worker/test_worker.py
```

With the local server running, `npm run smoke` checks HTTP assets, input/origin boundaries, a complete offline experiment, export and persisted run data. It adds one demo run to the experiment history.

Verification completed: ten Node tests, Python calibration/boundary checks, and local HTTP smoke checks for creation, polling, asset delivery, export, persistence and input/origin validation. The final offline smoke run produced 24 concepts, 3 finalists, 8 SVG renders and 2 cache hits. Paid OpenAI requests and actual GPU inference were **not executed**. No controllable browser was available in this session, so visual layout and browser interaction testing remain unverified; the frontend received syntax, CSS and markup checks.

There is no measured TRIBE speedup claim. The fast offline demonstration tests the workflow only. See [the full plan](docs/PLAN.md) for the fitness design, latency budget, staged implementation, extensions, and missing evidence.
