# TRIBE v2: research and integration notes

Verified against primary sources on 2026-09-19. Confirmed upstream behavior is separated from proposed application design below.

## What is established

- **Prediction target:** fMRI-like brain activity, not emotion labels, persuasion, attention, purchase intent, or conversion probabilities. The released quick start returns an average-subject cortical response on the fsaverage5 surface, approximately 20,000 vertices. It accepts video, audio, or text. See [Meta repository](https://github.com/facebookresearch/tribev2).
- **Timing and scientific scope:** the paper uses 1 Hz fMRI outputs, 100-second context windows, and a five-second hemodynamic offset. It demonstrates visual/language contrasts, including emotional versus physical pain; that experiment does not establish an advertising emotion scorer. The paper reports 720 subjects across its combined training/evaluation datasets; these are not 720 training subjects. See [paper, methods and results](https://arxiv.org/html/2605.04326v1).
- **License/access:** code and weights use CC-BY-NC-4.0. A commercial advertising product needs a suitable license or a different model. The text encoder requires gated Llama access. The model page currently lists no hosted Hugging Face Inference Provider. See [model card](https://huggingface.co/facebook/tribev2) and [license](https://github.com/facebookresearch/tribev2/blob/main/LICENSE).
- **Encoders:** the released configuration specifies `meta-llama/Llama-3.2-3B`, `facebook/w2v-bert-2.0`, and `facebook/vjepa2-vitg-fpc64-256`, with persistent feature caches. Its video feature frequency is 2 Hz; this is the embedding frequency, not the number of decoded frames. Feature devices are separately configured as CUDA. See [released configuration](https://huggingface.co/facebook/tribev2/blob/main/config.yaml).
- **Preprocessing:** the high-level text helper synthesizes speech using gTTS and then transcribes it for word timings. Video input also runs audio/text preprocessing. The speech extractor invokes WhisperX with `large-v3`. These stages can dominate cold requests and introduce dependencies beyond the brain model. See [inference wrapper](https://github.com/facebookresearch/tribev2/blob/main/tribev2/demo_utils.py) and [event transforms](https://github.com/facebookresearch/tribev2/blob/main/tribev2/eventstransforms.py).
- **Runtime:** upstream requires Python 3.11+ and currently pins PyTorch to `>=2.5.1,<2.7`, plus neuralset/neuraltrain and several multimedia dependencies. Use a separate pinned GPU environment instead of adding these dependencies to the web app. See [package definition](https://github.com/facebookresearch/tribev2/blob/main/pyproject.toml).

## Supported adapter boundary

The official entry point is:

```python
from tribev2 import TribeModel

model = TribeModel.from_pretrained("facebook/tribev2", cache_folder="./cache")
events = model.get_events_dataframe(video_path="candidate.mp4")
predictions, segments = model.predict(events=events)
```

`predictions` is a time-by-vertex array; `segments` provides alignment. The wrapper also supports exactly one `audio_path` or `text_path`. It has no direct `image_path` argument. See [official quick start](https://github.com/facebookresearch/tribev2#quick-start).

For still-image ads, a proposed adapter must present a controlled, timed static video and validate that protocol. The paper itself transforms experimental images into timed static videos. Do not silently treat a caption-only score as a score of the image. See [paper, visual experiments](https://arxiv.org/html/2605.04326v1#S5.SS9).

An application service should return a media content hash, upstream revision, preprocessing version, temporal/vertex shape, actual elapsed time, and decoder version alongside any scores. Preserve raw neural predictions for analysis. If the service has no trained emotion decoder, return neural features and an explicit uncalibrated status; never relabel arbitrary ROI means as validated emotion probabilities.

## Emotion scoring: proposed, requires validation

Treat TRIBE as an optional feature generator. Collect consented viewer ratings for valence/arousal and named goals such as warmth, curiosity, confidence, or excitement on representative ads. Fit a regularized decoder from pooled neural features to those labels. Split evaluation by campaign/product and creative family so near-duplicate mutations cannot leak across train/test sets. Compare with a simpler text/image embedding model and a copy-quality baseline. Measure held-out rank agreement, uncertainty, calibration, and subgroup performance before letting this decoder drive selection.

Use normalized user weights over target emotions, with separate brand clarity, factual support, visual quality, and diversity terms. Emotional intensity can be negative or unrelated to the product, so maximize target alignment rather than total predicted activation. Keep explicit claims tied to supplied or researched evidence. Preserve a champion and multiple distinct creative families; use mutation/crossover and occasional random exploration. Finalists still need human review and an actual controlled ad experiment. A rise in model fitness is not evidence of a rise in human response or sales.

## Speed plan: proposed, benchmark before promising latency

1. Generate many inexpensive genomes, copy options, and storyboard previews. Use the fast proxy to shortlist candidates; spend full rendering and TRIBE budget only on the shortlist plus one exploration candidate per round.
2. Reuse the unchanged champion's measurements. Cache by rendered media bytes, upstream revision, preprocessing settings, and decoder version. Cache raw neural predictions separately from user-weighted scores, so changing weights does not rerun TRIBE.
3. Keep a long-lived GPU worker and persistent feature cache. Separate web/job orchestration from the GPU process. Limit concurrent GPU requests to prevent VRAM contention; parallelize provider calls and CPU work where independent.
4. Reuse unchanged narration, audio, and imagery. Construct validated timed events from the generation system's known narration timestamps to avoid the text-to-speech-to-ASR round trip. This is a custom adapter optimization, not an existing switch on `get_events_dataframe`.
5. After initial labeled runs, fit a cheap surrogate and query TRIBE on promising or uncertain candidates. Reserve exploration to detect surrogate blind spots. Surrogate training on TRIBE scores accelerates that scorer; it does not independently validate emotional meaning.
6. Stop when the budget is exhausted or improvement stalls. Rescore the final actual media with the full configuration. Display cached, proxy, neural, and human-evaluated results separately.

Illustrative call budget: a population of 12 over four rounds costs 48 full evaluations if everything is rescored. A cap of three shortlist candidates plus one exploration candidate per round costs at most 16, a 67% reduction in calls before cache hits. This is a planning calculation, not a measured runtime speedup. Preview screening can miss a strong candidate, which motivates exploration and final rescoring.

Do not reduce temporal resolution, replace feature extractors, remove modalities, change context, or quantize solely on intuition. Those changes can alter the ranking; benchmark fidelity against the released pipeline. Caching only an edited scene's features also requires respecting context across scene boundaries. Start with whole-media cache correctness before attempting partial invalidation.

## What remains unknown

No reproducible end-to-end per-ad inference benchmark or guaranteed minimum VRAM was found in the official materials examined. The paper's 32 GB V100 training/feature-extraction figures describe a research workload, not a deployment minimum. Its feature extraction run spans 128 GPUs and is not a one-clip latency claim. See [paper, implementation details](https://arxiv.org/html/2605.04326v1#S5.SS2).

The [official demo notebook](https://github.com/facebookresearch/tribev2/blob/main/tribe_demo.ipynb) enables a GPU and contains example outputs, but these do not provide a controlled cold/warm full-pipeline benchmark. Record preprocessing, each encoder, brain inference, decoding, peak VRAM, and cache hit rates on fixed 6/15/30-second clips. Compare cold/warm runs and multiple seeds before setting product expectations.

Missing pieces for a production claim: licensed model deployment, target-audience emotion labels, a validated decoder, real media-provider credentials, controlled latency measurements, downstream ad experiments, content ownership/consent handling, and evidence that TRIBE adds predictive value over cheaper baselines. The prototype may demonstrate the optimization workflow before these are available, provided its demo scores remain clearly labeled.
