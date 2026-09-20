<div align="center">

<img src="advolve.png" width="240" height="240">

Evolve your ads.

[![GitHub stars](https://img.shields.io/github/stars/LargoLardo/htn-2026-ad-evolve?style=social)](https://github.com/LargoLardo/htn-2026-ad-evolve)
[![GitHub forks](https://img.shields.io/github/forks/LargoLardo/htn-2026-ad-evolve?style=social)](https://github.com/LargoLardo/htn-2026-ad-evolve/network/members)

</div>

---

**Stop guessing which ad creative works. Evolve it.**

Advolve generates ad variations, reviews the actual pixels, then uses an evolutionary algorithm guided by TRIBE neural scoring to breed stronger creatives generation over generation. Images use OpenAI; videos use Seedance 2.0 through Pika. Every take is scored by predicted cortical response, not heuristics.

Hosted app: [Advolve on Cloudflare](https://advolve-web.advolve-logan.workers.dev)
(Access sign-in required). See [deployment, credentials and live test results](docs/CLOUDFLARE_DEPLOY.md).
General production workloads require Workers Paid; the small live tests were
recovered under Free's limits. Neural scores represent predicted cortical
response, not validated emotion, engagement or conversion performance.

## Key Features

### Evolutionary Creative Engine

Describe your product, and Advolve runs a full evolutionary loop over your ad creatives.

- **Research and Concepting**: Researches your brief, generates concepts and renders a population of ad takes with an 8-gene genome (hook, visual, emotion, proof, CTA, palette, motion, audio).
- **Automated Review**: Reviews actual pixels, copy, product visibility, claims and brief alignment. Copy passes when every required word appears in the visible text or audio transcript, ignoring capitalization, punctuation, spacing, order and repetition; extra text is allowed. Takes with visual quality of at least 80/100 can enter the neural shortlist with missing-copy warnings when their other checks pass and brief alignment is at least 60/100. Video review samples six frames and transcribes audio with Whisper.
- **Neural Scoring**: Shortlisted takes are scored by TRIBE, a neuroscience model that predicts cortical response across four Glasser parcel families.
- **Selection and Breeding**: Ranks takes by neural score, retains the winner, applies crossover and single-gene mutation to produce the next generation.
- **Manual Gates (Cloudflare)**: Optionally pause between rounds to hand-pick parents, kill weak nodes and edit the brief before the next generation breeds. Local Node runs select parents automatically.

### Brain Visualizer

Explore what the neural model sees, mapped onto an interactive 3D cortical surface.

- **3D Cortex**: Three.js rendering of the Glasser parcellation with per-parcel activation heatmaps.
- **Four Families**: Auditory engagement, language/message, attention/salience and visual/motion, each a group of Glasser parcels.
- **Keyboard Navigation**: Select parcels and families from the keyboard; activation values update live.

### Impact and Attention Maps

Understand which elements of your ad are doing the work and which are dead weight.

- **Attention Map**: DeepGaze IIE predicts where people look, reduced to the same detected elements as the impact map.
- **Impact Map**: Occludes each detected element one at a time and measures the neural score delta.
- **Gap View**: Normalizes both maps and shows the difference. High attention + low impact means an element draws the eye but does nothing.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend framework | Next.js, React, TypeScript |
| 3D visualization | Three.js (brain cortex renderer) |
| Backend | Node.js 22+, zero npm dependencies |
| Media processing | FFmpeg (occlusion masking, video frames, audio) |
| Image generation | OpenAI `gpt-image-2.5-flare` |
| Video generation | Seedance 2.0 via Pika REST API |
| Neural scoring | TRIBE worker on Baseten (L4 GPU) |
| Attention model | DeepGaze IIE (PyTorch, Baseten) |
| AI research/review | OpenAI `gpt-6-astra` |
| Cloudflare deployment | Workers, D1, R2, Durable Objects, Queues, Workflows |
| Python worker | NumPy, Pillow, PyTorch, Hugging Face |

## How It Works

### Evolution loop

```
Brief + product description
  -> Research the category and competitors
  -> Generate population of ad takes (8-gene genome)
  -> Review actual media (pixels, copy, claims)
  -> Score shortlist with TRIBE neural model
  -> Rank by cortical response, retain winner
  -> Crossover + single-gene mutation -> next generation
  -> Repeat for N rounds
```

### Impact map pipeline

```
Original ad image
  -> Detect elements (objects, text, logos)
  -> Score the unmodified original with TRIBE
  -> Occlude each element, re-score
  -> Delta = how much each element contributes
  -> Overlay with DeepGaze attention density
  -> Gap = where people look vs. what actually matters
```

## Run Locally

Local hosting remains supported alongside Cloudflare. Install Node.js 22.9+
and FFmpeg, then run the API and UI below. No Cloudflare account, Wrangler,
R2 or Access setup is required. Generation and neural scoring still call your
configured AI providers; local hosting does not mean offline inference.

See [the local hosting guide](docs/LOCAL_HOSTING.md) for production startup,
storage, optional attention maps and troubleshooting. To host on Cloudflare,
use [the Cloudflare deployment guide](docs/CLOUDFLARE_DEPLOY.md).

```bash
# 1. Install frontend dependencies (backend has zero npm deps)
npm ci --prefix web

# 2. Configure environment
cp .env.example .env
# Set OPENAI_API_KEY for research, image generation and review
# Set PIKA_API_KEY for video generation
# Set BASETEN_TRIBE_ENDPOINT + BASETEN_API_KEY for neural scoring

# 3. Start backend; automatically loads .env
npm start                 # API on 127.0.0.1:3000

# 4. Start frontend (separate terminal)
npm run dev --prefix web   # UI on 127.0.0.1:3001
```

Open http://127.0.0.1:3001. The Next.js frontend proxies API requests to the backend.
Keep both processes running until your runs finish. Use `npm run dev` instead
of `npm start` for backend development with automatic restarts.

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENAI_API_KEY` | Image generation, research, review | Yes |
| `OPENAI_TEXT_MODEL` | Text model override (default: `gpt-6-astra`) | No |
| `OPENAI_IMAGE_MODEL` | Image model override (default: `gpt-image-2.5-flare`) | No |
| `PIKA_API_KEY` | Seedance 2.0 video generation | No |
| `BASETEN_TRIBE_ENDPOINT` | TRIBE neural scoring endpoint | Yes, unless `TRIBE_SCORE_URL` is set |
| `BASETEN_API_KEY` | Baseten API authentication | Yes for Baseten |
| `TRIBE_SCORE_URL` | Alternative scoring URL (same JSON contract) | No |
| `TRIBE_TOKEN` | Optional Bearer token for scoring | No |
| `FFMPEG_BIN` | FFmpeg executable path (default: `ffmpeg`) | No |
| `MEDIA_SERVICE_URL` | DeepGaze and FFmpeg service (Baseten) | Cloudflare video and attention maps |

## Repo Layout

```
.
├── cloudflare/          Cloudflare Workers deployment
│   ├── src/             Worker API, queue consumer, workflows, storage
│   ├── tests/           Vitest integration tests
│   ├── migrations/      D1 schema migrations
│   └── scripts/         Provisioning and deploy script
├── deploy/              Baseten model configurations
│   ├── baseten/         TRIBE scoring service
│   └── baseten-media/   DeepGaze + FFmpeg media service
├── docs/                Architecture and deployment docs
├── experimental/        Brain mesh export, paused decoder training
├── lib/                 Shared engine (evolution, scoring, maps, providers, grid)
├── maps/                Python saliency module (DeepGaze grid parity)
├── scripts/             Build and smoke test scripts
├── server.mjs           Node.js API server (zero dependencies)
├── tests/               Node test suite (engine, providers, media, scoring)
├── training/            OASIS data prep and training tests (paused)
├── web/                 Next.js frontend
│   ├── app/             Pages and routing
│   ├── components/      Dashboard, brain visualizer, maps, layout
│   └── lib/             Types, scoring utilities, backend proxy
├── worker/              TRIBE Python worker (scoring, spec, calibration)
└── .env.example         Environment template
```

## Verification

```bash
npm run check                  # syntax check all modules
npm run build --prefix web     # production frontend build
npm test                       # Node test suite (requires FFmpeg)
npm run smoke                  # smoke test against running server

# Python tests (requires NumPy, Pillow)
python -m unittest worker.test_neural training.test_training
```

## Team

Shawn Wei, Ethan Yang, William Yang, Logan Zhao

## License

MIT. Built for Hack the North 2026.
