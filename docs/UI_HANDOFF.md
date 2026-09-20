# UI handoff

Everything the interface needs to know about the maps and the lineage, plus
the problems that are known and not yet fixed. Written for someone picking up
`web/` without picking up the engine.

Work in `web/`. The engine lives in `lib/` and `server.mjs` and is being
changed in parallel, so the contract below is the boundary between you and it.

## Running it

```sh
set -a && . ./.env && set +a && node server.mjs    # API on :3000
cd web && npm run dev                              # UI on :3001, proxies /api
```

The API also serves `/assets/<hash>.png`. Both are proxied by
`web/app/api/[...path]/route.ts`, which strips the Origin header because
`server.mjs` rejects cross origin POSTs and a Next rewrite forwards Origin.

## Vocabulary, and why it is not negotiable

One idea, one word, everywhere: in the map, the ranked list, the tooltips and
the note fed back into generation.

| say | never say |
| --- | --- |
| round | generation |
| traits | genome, genes |
| parent node | parent |
| dead weight | looked at but does nothing, positive gap |
| carrying the ad | drives the response, negative gap |
| neutral | agrees, faint |

**No signed numbers outside the score.** On a node card a minus sign means
worse. On an element it used to mean the element was carrying the ad. The same
symbol meaning opposite things on one screen is the single most confusing
thing this interface has done, so element verdicts are words now.

## What the two maps are

- **Attention** is predicted gaze from DeepGaze IIE. It is free, runs on CPU,
  and is a continuous 1024px density served as a PNG with the density in the
  alpha channel.
- **Impact** is measured: hide one element of the ad, rescore it with Percept
  on a GPU, and see how far the score moved. One pass per element, about two
  minutes each, so a map is roughly half an hour.
- **The gap** is attention minus impact, per element. An element that gets
  looked at and changes nothing when removed is dead weight. One that changes
  a lot without being looked at is carrying the ad.

Anywhere no element was detected is **unpainted**, and it must stay that way.
Nothing was measured there. An earlier version drew a grid over the whole ad,
which implied the opposite.

## The artifact contract

`GET /api/maps/<mediaHash>` returns the JSON below.
`GET /api/maps/<mediaHash>/attention.png` returns the density PNG.
`GET /api/maps` lists the hashes that have artifacts.

```jsonc
{
  "mediaHash": "…", "width": 1024, "height": 1318,
  "runId": "…", "label": "Original",       // which run built it, and which role
  "builtAt": "…", "elapsedMs": 0,

  "attention": { "map": [/* 16x16 = 256 */], "source": "…", "provenance": "…" },

  "impact": {                               // null if the GPU was unavailable
    "calls": 13,
    "regions": [ /* one per element, the raw measurements */ ],
    "maps": {                               // one array per metric, DETECTION order
      "engagement": [], "attention_salience": [],
      "language_message": [], "visual_motion": [], "auditory_engagement": []
    },
    "provenance": "…"
  },
  "impactError": null,                      // set when impact is null

  "elements": [                             // sorted by gap, WORST FIRST
    {
      "label": "COCKTAIL PARTY headline",
      "kind": "headline",                   // headline|body text|photo|illustration|logo|background|other
      "order": 3,                           // detection order, see the trap below
      "x": 0.04, "y": 0.87, "w": 0.94, "h": 0.12,   // fractions of width/height
      "attention": 0.71,                    // 0-1, normalised across elements
      "impact": 0.22,                       // 0-1, normalised across elements
      "gap": 0.49                           // attention minus impact
    }
  ],

  "gap": { "metric": "attention_salience", "attention": [], "impact": [], "difference": [] }
}
```

**The trap.** `elements` is sorted by gap. `impact.maps[family]` is in
detection order. To show a different Percept family without another GPU pass
you must index `impact.maps[family]` by `element.order`, not by the element's
position in the list. Getting this wrong silently mislabels everything.

Boxes are fractions so they survive any display size. Multiply by the rendered
width and height, not by `width`/`height` from the artifact.

## Known problems, not yet fixed

1. **Old artifacts have a different shape.** Anything built before object
   occlusion has `grid` and cell arrays. The UI falls back to `element.impact`
   when `order` is missing, so they still render. Do not add more fallbacks,
   delete the old artifacts instead.
2. **Zoom is per view.** The lineage tree and the map each implement their own
   pan and zoom. If a third view needs it, extract a hook rather than writing
   a third copy.
3. **The map has no keyboard path.** Zoom and pan are pointer only. The tree
   pans to a focused node; the map does not.

## Things that will look like bugs and are not

- **Half the nodes say `not scored`.** Only the shortlist reaches the GPU,
  because a Percept pass costs about two minutes. This is intended to change.
- **Ads score below the original.** The node bar is 0-100 with the uploaded
  original ticked at 50, and a clean ad landing left of that tick is expected.
  The metric is response magnitude, and clutter maximises it.
- **A child looks nothing like its parents.** Lineage is inheritance of
  traits, and the image is generated from scratch afterwards. No pixels are
  inherited. Every viewer assumes otherwise, so the UI has to say it.
- **The lineage graph is dense.** Only four of eight nodes ever breed, so every
  edge radiates from a handful. Faded nodes are the ones nothing was bred from.

## Coming from the engine side

A gate at the end of each round, with `auto` and `manual` policies, where a
person picks parent nodes, kills nodes and edits the note sent to the next
round. Design it as a persistent Auto/Manual toggle in the run header plus a
decision bar above the tree. Pre-select the algorithm's own picks, so the
human edits a proposal rather than doing the work. See `docs/CLOUDFLARE_PORT.md`
for how the gate is meant to persist.
