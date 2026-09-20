"""Neural scoring worker; legacy feature/head endpoints remain experimental."""
import base64
import errno
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import threading

import numpy as np

from affect_decoder import AffectDecoder, load_spec, spec_hash
from clip_cache import install_exact_clip_cache
import tribe_worker
try:
    import neural_worker
except ImportError:
    from worker import neural_worker


def writable_cache(preferred, fallback):
    """Development replicas may not mount Baseten's shared /cache volume."""
    path = Path(preferred)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        if error.errno not in [errno.EACCES, errno.EROFS]:
            raise
        path = Path(fallback)
        path.mkdir(parents=True, exist_ok=True)
        print("Shared cache unavailable; using ephemeral replica storage.", flush=True)
    return path


def register_snapshot(snapshot, revision, registry):
    """Allow only downloaded, pinned local weights through neuralset's repo check."""
    path = Path(snapshot)
    if path.name != revision or not (path / "config.json").is_file() or not any(path.glob("*.safetensors")):
        raise ValueError("Encoder snapshot is missing pinned configuration or safetensor weights.")
    # neuralset 0.0.2 validates names against an in-memory repo allowlist before
    # passing them to Transformers, which supports local snapshot paths directly.
    if str(path) not in registry:
        registry.append(str(path))


class Model:
    def __init__(self, **kwargs):
        self.secrets = kwargs.get("secrets", {})
        self.data_dir = Path(kwargs.get("data_dir", "data"))
        self.spec = load_spec()
        self.neural_spec, self.neural_contract_hash = neural_worker.contract()
        if any(self.spec[key] != self.neural_spec[key] for key in ['model_repo', 'model_revision', 'code_revision', 'encoders']):
            raise ValueError('Loaded TRIBE/encoder pins must match the neural scoring contract.')
        self.feature_spec_hash = spec_hash(self.spec)
        self.decoder = None
        self.lock = threading.Lock()

    def load(self):
        print("Importing TRIBE inference dependencies...", flush=True)
        import torch
        from huggingface_hub import snapshot_download
        from tribev2 import TribeModel
        from neuralset.extractors.base import HuggingFaceMixin

        torch.set_float32_matmul_precision("high")
        torch.backends.cudnn.allow_tf32 = True

        if not torch.cuda.is_available():
            raise RuntimeError("This deployment requires a CUDA GPU.")
        token = self.secrets.get("hf_access_token")
        if not token:
            raise RuntimeError("Configure the Baseten secret hf_access_token with access to the gated encoder.")
        self.runtime_versions = {name: importlib.metadata.version(name) for name in
            ["torch", "torchvision", "transformers", "numpy", "Pillow", "neuralset", "tribev2"]}
        runtime_hash = hashlib.sha256(json.dumps(self.runtime_versions, sort_keys=True).encode()).hexdigest()
        cache_root = writable_cache(os.environ.get("TRIBE_CACHE_DIR", "/cache/org/evolve-tribe"), "/tmp/evolve-tribe")
        hf_cache = writable_cache(os.environ.get("HF_HOME", "/cache/org/evolve-huggingface"), "/tmp/evolve-huggingface")
        cache = cache_root / self.feature_spec_hash / runtime_hash / "exact-clip-cache-v1"
        cache.mkdir(parents=True, exist_ok=True)
        print("Downloading pinned TRIBE checkpoint...", flush=True)
        checkpoint = snapshot_download(self.spec["model_repo"], revision=self.spec["model_revision"],
            token=token, cache_dir=str(hf_cache), allow_patterns=["config.yaml", "best.ckpt", "LICENSE"])
        # Training's 20 forked loader workers can deadlock inside an inference
        # server thread after CUDA initialization. Our requests contain one clip.
        config_update = {"data.num_workers": 0}
        for field, encoder in self.spec["encoders"].items():
            print(f"Downloading pinned encoder: {encoder['repo']}", flush=True)
            config_update[field] = snapshot_download(encoder["repo"], revision=encoder["revision"], token=token,
                cache_dir=str(hf_cache),
                allow_patterns=["*.json", "*.safetensors", "tokenizer.model", "LICENSE*"],
                ignore_patterns=["original/*"])
            register_snapshot(config_update[field], encoder["revision"], HuggingFaceMixin._REPOS)
        if self.spec["protocol"] != tribe_worker.SHORT_LOSSLESS_PROTOCOL:
            raise RuntimeError("This affect experiment requires the versioned 10-second lossless static-video protocol.")
        tribe_worker.PROTOCOL = self.spec["protocol"]
        tribe_worker.CACHE = cache
        tribe_worker.REVISION = self.spec["model_revision"]
        tribe_worker.CODE_REVISION = self.spec["code_revision"]
        print("Loading TRIBE checkpoint onto GPU...", flush=True)
        tribe_worker.MODEL = TribeModel.from_pretrained(checkpoint, cache_folder=str(cache / "percept-features-v1"),
            device="cuda", config_update=config_update)
        import neuralset.extractors.video as video_extractors
        self.clip_cache_stats = {"hits": 0, "misses": 0, "verification_forwards": 0}
        install_exact_clip_cache(video_extractors, config_update["data.video_feature.image.model_name"],
            self.clip_cache_stats, verify_equal=torch.equal)
        decoder_path = self.data_dir / "decoder.npz"
        if decoder_path.exists():
            self.decoder = AffectDecoder(decoder_path, expected_spec=self.spec)
            if self.decoder.metadata.get("runtime_versions") != self.runtime_versions:
                raise RuntimeError("Decoder features were produced with different inference-library versions.")
        print("TRIBE worker ready.", flush=True)

    def predict(self, model_input):
        if not isinstance(model_input, dict):
            raise ValueError("Expected a JSON object.")
        action = model_input.get("action", "features")
        if action == "health":
            return {"feature_spec_hash": self.feature_spec_hash,
                "percept_contract_hash": self.neural_contract_hash, "percept_version": self.neural_spec['version'],
                "labels": ["valence", "arousal"], "decoder_version": self.decoder.metadata["version"] if self.decoder else None,
                "runtime_versions": getattr(self, "runtime_versions", {}), "model_loaded": tribe_worker.MODEL is not None}
        if action in ["percept", "neural"]:
            if tribe_worker.MODEL is None:
                raise RuntimeError("TRIBE model is not loaded.")
            with self.lock:
                return neural_worker.score_batch(model_input, tribe_worker.MODEL, tribe_worker.CACHE,
                    getattr(self, "runtime_versions", {}))
        if action not in ["features", "score"]:
            raise ValueError("action must be health, neural, features or score.")
        if action == "score":
            if self.decoder is None:
                raise ValueError("No affect decoder has been fitted and bundled. Use action=features first.")
            if model_input.get("decoder_version") != self.decoder.metadata["version"]:
                raise ValueError("Decoder version mismatch.")
        candidates = model_input.get("candidates")
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= 4:
            raise ValueError("Send 1–4 candidates; one per request is recommended for extraction.")
        ids = [candidate.get("id") if isinstance(candidate, dict) else None for candidate in candidates]
        if any(not isinstance(item_id, str) or not item_id or len(item_id) > 200 for item_id in ids) or len(set(ids)) != len(ids):
            raise ValueError("Expected unique nonempty candidate IDs.")
        results = []
        # Also guard direct callers: the underlying resident model/cache is serial.
        with self.lock:
            for candidate in candidates:
                stats_before = dict(getattr(self, "clip_cache_stats", {}))
                pooled, media_hash, _, metadata = tribe_worker.extract(candidate)
                metadata = {**metadata, "feature_spec_hash": self.feature_spec_hash,
                    "protocol": self.spec["protocol"], "model_revision": self.spec["model_revision"],
                    "code_revision": self.spec["code_revision"],
                    "runtime_versions": getattr(self, "runtime_versions", {}),
                    "execution_config": {"data.num_workers": 0, "exact_clip_cache": "v1"},
                    "clip_cache": {key: value - stats_before.get(key, 0)
                        for key, value in getattr(self, "clip_cache_stats", {}).items()},
                    "uncertainty": "not-estimated"}
                result = {"id": candidate["id"], "media_hash": media_hash, "metadata": metadata}
                if action == "features":
                    raw = np.asarray(pooled, dtype="<f4").tobytes()
                    result.update(pooled_f32_base64=base64.b64encode(raw).decode(), feature_dim=len(pooled),
                        pooled_sha256=hashlib.sha256(raw).hexdigest())

                else:
                    result.update(affect=self.decoder.score(pooled), confidence=None,
                        provenance="Frozen TRIBE features + OASIS-fitted valence/arousal decoder; experimental estimated ratings.")
                results.append(result)
        return {"feature_spec_hash": self.feature_spec_hash,
            "decoder_version": self.decoder.metadata["version"] if self.decoder else None, "results": results}
