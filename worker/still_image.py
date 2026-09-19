"""Serial, direct still-image adapter for the pinned TRIBE/neuralset versions.

Only sensory extraction is replaced. Upstream segmentation, layer aggregation,
padding, brain inference and timestamps remain in TribeModel.predict. No MP4 is
used after the mandatory first-image comparison with the legacy reference path.
"""
from contextlib import contextmanager, ExitStack
import hashlib
import io
import inspect
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image

from worker.affect_decoder import spec_hash
from worker.tribe_worker import (MPS_FIVE_SECOND_PROTOCOL, MPS_STILL_PROTOCOL,
    pool_predictions, predict_png_reference, validate_png)


def repeated_frames(raw, num_frames=64, max_imsize=None):
    with Image.open(io.BytesIO(raw)) as image:
        image = image.convert("RGB")
        if max_imsize is not None and max(image.size) > max_imsize:
            factor = max(image.size) / max_imsize
            image = image.resize(tuple(int(size / factor) for size in image.size))
        pixels = np.asarray(image).copy()
    # A view avoids 64 copies of the full-resolution PNG. The unchanged upstream
    # processor receives the same 64 uint8 RGB frames as the lossless video path.
    return np.broadcast_to(pixels, (num_frames, *pixels.shape))


@contextmanager
def override_data(extractor, function):
    """Route only this instance through a scoped, exception-safe descriptor bridge.

    exca makes _get_data a read-only property, so an instance attribute cannot
    override it. Other instances still use the original descriptor. This adapter
    is serial and num_workers=0; no installed dependency source is changed.
    """
    sentinel = object()
    cls = type(extractor)
    old = cls.__dict__.get("_get_data", sentinel)
    descriptor = inspect.getattr_static(cls, "_get_data")
    def get_data(instance):
        return function if instance is extractor else descriptor.__get__(instance, type(instance))
    setattr(cls, "_get_data", property(get_data))
    try:
        yield
    finally:
        if old is sentinel:
            delattr(cls, "_get_data")
        else:
            setattr(cls, "_get_data", old)


def compare_arrays(actual, expected, label):
    actual, expected = np.asarray(actual), np.asarray(expected)
    if actual.shape != expected.shape or not np.isfinite(actual).all() or not np.isfinite(expected).all():
        raise RuntimeError(f"Still/MP4 parity failed: {label} shape or finite values.")
    error = float(np.max(np.abs(actual - expected)))
    if not np.allclose(actual, expected, rtol=1e-5, atol=1e-5):
        raise RuntimeError(f"Still/MP4 parity failed: {label}, maximum absolute difference {error}.")
    return {"shape": list(actual.shape), "exact_equal": bool(np.array_equal(actual, expected)),
        "max_absolute_error": error, "rtol": 1e-5, "atol": 1e-5}


class StillImageExtractor:
    def __init__(self, model, spec, cache, stats):
        self.model, self.spec, self.cache, self.stats = model, spec, Path(cache), stats
        if spec["protocol"] != MPS_STILL_PROTOCOL:
            raise ValueError("Direct still extraction requires its own v5 specification.")
        video, audio = model.data.video_feature, model.data.audio_feature
        if (video.frequency != 2 or audio.frequency != 2 or video.clip_duration != 4
                or model.data.num_workers != 0 or model._model.device.type != "mps"):
            raise ValueError("Unreviewed TRIBE configuration for the direct still adapter.")
        self.video_model = None
        self.silence = None
        self.parity = None

    def _video_array(self, raw):
        from neuralset import base
        from neuralset.extractors import video as video_module
        extractor = self.model.data.video_feature
        if self.video_model is None:
            self.video_model = video_module._HFVideoModel(model_name=extractor.image.model_name,
                pretrained=extractor.image.pretrained, layer_type=extractor.layer_type,
                num_frames=extractor.num_frames)
            self.video_model.model.to(extractor.image.device)
        encoder = self.video_model
        if encoder.num_frames != 64 or encoder.model.training or encoder.model.device.type != "mps":
            raise RuntimeError("Expected the pinned 64-frame V-JEPA encoder in MPS eval mode.")
        frames = repeated_frames(raw, encoder.num_frames, extractor.max_imsize)
        hidden = encoder.predict_hidden_states(frames)
        self.stats["still_video_forwards"] = self.stats.get("still_video_forwards", 0) + 1
        if hidden.shape[0] != 1 or hidden.device.type != "mps":
            raise RuntimeError("Invalid V-JEPA batch or device.")
        # Exactly the upstream token/layer aggregation order. In particular do
        # not average the selected layer groups or the cortical timeline early.
        embedding = extractor.image._aggregate_tokens(hidden[0]).cpu().numpy()
        if not extractor.image.cache_all_layers and extractor.image.cache_n_layers is None:
            embedding = extractor.image._aggregate_layers(embedding)
        encoder.clear_exact_clip_cache()  # retain only the small aggregated result
        del hidden
        data = np.repeat(embedding[..., None], 10, axis=-1).astype(np.float32)
        return base.TimedArray(data=data, frequency=2, start=base._UNSET_START, duration=5)

    def _audio_array(self):
        if self.silence is not None:
            self.stats["silence_reuses"] = self.stats.get("silence_reuses", 0) + 1
            return self.silence
        import torch
        from torch.nn import functional as F
        from neuralset import base
        extractor = self.model.data.audio_feature
        # Zero *waveform*, not fabricated zero embeddings. Run the actual audio
        # processor/model and upstream temporal resampling once per process.
        wav = torch.zeros((5 * 48000, 2), dtype=torch.float32)
        wav = extractor._resample_wav(wav, 48000, extractor._input_frequency)
        wav = extractor._preprocess_wav(wav)
        latents = extractor._process_wav(wav)
        if extractor.model.device.type != "mps" or extractor.model.training:
            raise RuntimeError("Silent audio encoder did not run on MPS in eval mode.")
        if latents.shape[-1] != 10:
            latents = F.interpolate(latents[None], 10)[0] if latents.ndim == 2 else F.interpolate(latents, 10)
        self.silence = base.TimedArray(data=latents.numpy(), frequency=2,
            start=base._UNSET_START, duration=5)
        self.stats["silence_forwards"] = self.stats.get("silence_forwards", 0) + 1
        return self.silence

    def _predict(self, arrays, media_hash):
        import pandas as pd
        rows = []
        with ExitStack() as stack:
            for modality, kind, frequency in [("video", "Video", 25), ("audio", "Audio", 48000)]:
                uri = f"inmemory:{modality}:{media_hash if modality == 'video' else 'silence-5s-v5'}"
                rows.append(dict(type=kind, filepath=uri, start=0, duration=5, frequency=frequency,
                    timeline="default", subject="default"))
                def get_data(events, *, uri=uri, array=arrays[modality], frequency=frequency):
                    for event in events:
                        if (event.filepath != uri or event.start != 0 or event.offset != 0
                                or event.duration != 5 or event.frequency != frequency):
                            raise RuntimeError("Unexpected event in direct still extraction.")
                        yield array
                stack.enter_context(override_data(getattr(self.model.data, f"{modality}_feature"), get_data))
            return self.model.predict(events=pd.DataFrame(rows), verbose=False)

    def _verify_reference(self, raw, arrays, predictions, segments):
        observed = {}
        start = time.monotonic()
        with ExitStack() as stack:
            for modality in ("video", "audio"):
                extractor = getattr(self.model.data, f"{modality}_feature")
                original = extractor._get_data
                def record(events, *, original=original, modality=modality):
                    for array in original(events):
                        if array.duration != 5 or array.frequency != 2:
                            raise RuntimeError("Reference feature timeline differs from the still protocol.")
                        observed[modality] = compare_arrays(arrays[modality].data, array.data, modality)
                        yield array
                stack.enter_context(override_data(extractor, record))
            reference, reference_segments = predict_png_reference(raw, self.model, MPS_FIVE_SECOND_PROTOCOL)
        if set(observed) != {"video", "audio"}:
            raise RuntimeError("Did not verify both real reference sensory encoders.")
        if [(s.start, s.duration) for s in segments] != [(s.start, s.duration) for s in reference_segments]:
            raise RuntimeError("Reference neural timestamps differ.")
        observed["brain_predictions"] = compare_arrays(predictions, reference, "brain predictions")
        self.video_model.clear_exact_clip_cache()
        return {"status": "passed", "reference_protocol": MPS_FIVE_SECOND_PROTOCOL,
            "comparisons": observed, "reference_seconds": time.monotonic() - start,
            "scope": "First real image in this process; numerical parity, not scientific validation."}

    def extract(self, candidate):
        raw, media_hash = validate_png(candidate)
        start = time.monotonic()
        arrays = {"video": self._video_array(raw), "audio": self._audio_array()}
        predictions, segments = self._predict(arrays, media_hash)
        predictions = np.asarray(predictions, dtype=np.float32)
        if predictions.shape != (5, 20484):
            raise RuntimeError(f"Unexpected cortical prediction shape: {predictions.shape}")
        direct_seconds = time.monotonic() - start
        if self.parity is None:
            print("Checking direct still features and brain predictions against one lossless MP4...", flush=True)
            self.parity = self._verify_reference(raw, arrays, predictions, segments)
            self.parity["media_hash"] = media_hash
            print(json.dumps({"still_reference_parity": self.parity}), flush=True)
        pooled = pool_predictions(predictions, self.spec["protocol"])
        key = hashlib.sha256(f"{media_hash}:{spec_hash(self.spec)}".encode()).hexdigest()
        path = self.cache / "neural" / f"{key}.npz"
        path.parent.mkdir(parents=True, exist_ok=True)
        # Only validated real results are persisted. The outer runner handles
        # checksummed resume and runtime matching; never trust a stale inner hit.
        np.savez_compressed(path, predictions=predictions, pooled=pooled)
        return pooled, media_hash, path, {"cached": False, "shape": list(predictions.shape),
            "duration_seconds": 5, "direct_seconds": direct_seconds,
            "elapsed_seconds": time.monotonic() - start, "still_reference_parity": self.parity,
            "extraction_path": "direct-still-v1"}
