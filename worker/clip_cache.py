"""Exact-input memoization for the pinned, eval-mode V-JEPA video encoder.

No approximate embeddings or synthetic features: a hit requires the same dtype,
shape and every decoded input byte. Upstream V-JEPA ignores the audio argument.
"""
import hashlib
from functools import lru_cache

import numpy as np


def install_exact_clip_cache(video_module, model_path, stats, verify_equal=None):
    original_class = video_module._HFVideoModel
    if getattr(original_class, "_evolve_exact_cache", False):
        raise RuntimeError("Exact clip cache is already installed.")

    class CachedVideoModel(original_class):
        def clear_exact_clip_cache(self):
            self._evolve_output = None
            self._evolve_key = None
            self._evolve_verified = False

        def predict_hidden_states(self, images, audio=None):
            if self.model_name != model_path or self.model.training:
                return super().predict_hidden_states(images, audio)
            pixels = np.ascontiguousarray(images)
            key = (pixels.dtype.str, pixels.shape, hashlib.sha256(memoryview(pixels).cast("B")).digest())
            if key == getattr(self, "_evolve_key", None):
                if verify_equal is not None and not self._evolve_verified:
                    reference = super().predict_hidden_states(images, audio)
                    if not verify_equal(self._evolve_output, reference):
                        raise RuntimeError("Repeated identical V-JEPA inputs produced different features; caching refused.")
                    self._evolve_verified = True
                    stats["verification_forwards"] = stats.get("verification_forwards", 0) + 1
                stats["hits"] += 1
                return self._evolve_output
            # Keep only one result, releasing it before the next GPU forward.
            self._evolve_output = None
            self._evolve_key = None
            self._evolve_verified = False
            result = super().predict_hidden_states(images, audio)
            self._evolve_output, self._evolve_key = result, key
            stats["misses"] += 1
            return result

    @lru_cache(maxsize=1)
    def cached_model(model_name, pretrained, layer_type, num_frames):
        return CachedVideoModel(model_name, pretrained, layer_type, num_frames)

    def resident_model(model_name, pretrained=True, layer_type="", num_frames=None):
        # Canonicalize positional/keyword calls before lru_cache; otherwise the
        # direct and reference routes could load two copies of a 4GB model.
        return cached_model(model_name, pretrained, layer_type, num_frames)

    # The pinned neuralset module uses the constructor and its MODELS tuple.
    resident_model.MODELS = original_class.MODELS
    resident_model._evolve_exact_cache = True
    video_module._HFVideoModel = resident_model
