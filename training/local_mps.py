"""Pinned TRIBE loader for Apple Silicon; no Baseten calls or CUDA fallback."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path

from worker.affect_decoder import load_spec, spec_hash

SPEC_PATH = Path(__file__).resolve().parents[1] / "worker/affect_spec_mps_still5s.json"


def download_snapshots(cache_dir):
    from training.pause import require_experimental_resume
    require_experimental_resume()
    from huggingface_hub import get_token, snapshot_download
    spec = load_spec(SPEC_PATH)
    token = get_token()
    if not token:
        raise RuntimeError("Run .venv/bin/hf auth login locally with the approved Hugging Face account first.")
    cache_dir = Path(cache_dir).resolve()
    print("Downloading pinned TRIBE checkpoint (resumable)...", flush=True)
    checkpoint = snapshot_download(spec["model_repo"], revision=spec["model_revision"],
        token=token, cache_dir=str(cache_dir), allow_patterns=["config.yaml", "best.ckpt", "LICENSE"], max_workers=3)
    encoders = {}
    for field, encoder in spec["encoders"].items():
        # Silent stimuli have no Word events. Pin its config/tokenizer, but do
        # not fetch ~6GB of text weights that this protocol never evaluates.
        patterns = ["*.json", "tokenizer.model", "LICENSE*"]
        if field != "data.text_feature.model_name":
            patterns.append("*.safetensors")
        print(f"Downloading pinned encoder: {encoder['repo']}", flush=True)
        encoders[field] = snapshot_download(encoder["repo"], revision=encoder["revision"],
            token=token, cache_dir=str(cache_dir), allow_patterns=patterns,
            ignore_patterns=["original/*"], max_workers=3)
    return checkpoint, encoders


def load_mps(cache_root=Path("data/tribe-mps"), model_cache=Path("data/huggingface")):
    from training.pause import require_experimental_resume
    require_experimental_resume()
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0") != "0":
        raise RuntimeError("Disable PYTORCH_ENABLE_MPS_FALLBACK: this protocol must not silently fall back to CPU kernels.")
    import torch
    import imageio_ffmpeg
    if not torch.backends.mps.is_available():
        raise RuntimeError("Apple Metal/MPS GPU is unavailable; no automatic CPU fallback.")
    torch.set_num_threads(4)
    torch.mps.set_per_process_memory_fraction(0.70)
    os.environ["FFMPEG_BIN"] = imageio_ffmpeg.get_ffmpeg_exe()
    os.environ["IMAGEIO_FFMPEG_EXE"] = os.environ["FFMPEG_BIN"]
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    checkpoint, encoders = download_snapshots(model_cache)
    from tribev2 import TribeModel
    from neuralset.extractors.base import HuggingFaceMixin
    import neuralset.extractors.video as video_extractors
    from worker import tribe_worker
    from worker.clip_cache import install_exact_clip_cache
    spec = load_spec(SPEC_PATH)
    for field, snapshot in encoders.items():
        path = Path(snapshot)
        if path.name != spec["encoders"][field]["revision"] or not (path / "config.json").is_file():
            raise ValueError("Missing pinned encoder configuration.")
        if field != "data.text_feature.model_name" and not any(path.glob("*.safetensors")):
            raise ValueError("Missing encoder weights.")
        if str(path) not in HuggingFaceMixin._REPOS:
            HuggingFaceMixin._REPOS.append(str(path))
    versions = {name: importlib.metadata.version(name) for name in
        ["torch", "torchvision", "transformers", "numpy", "Pillow", "neuralset", "tribev2"]}
    versions["execution_backend"] = spec["execution_backend"]
    versions["platform"] = "macos-arm64"
    versions["extraction_path"] = "direct-still-v1"
    versions["still_adapter_sha256"] = hashlib.sha256(
        (SPEC_PATH.parent / "still_image.py").read_bytes()).hexdigest()
    runtime_hash = hashlib.sha256(json.dumps(versions, sort_keys=True).encode()).hexdigest()
    cache = Path(cache_root).resolve() / spec_hash(spec) / runtime_hash / "direct-still-v1"
    cache.mkdir(parents=True, exist_ok=True)
    tribe_worker.PROTOCOL = spec["protocol"]
    tribe_worker.CACHE = cache
    tribe_worker.REVISION = spec["model_revision"]
    tribe_worker.CODE_REVISION = spec["code_revision"]
    config = {**encoders, "data.num_workers": 0,
        "data.audio_feature.device": "cpu", "data.video_feature.image.device": "cpu",
        "data.text_feature.device": "cpu"}
    print("Loading TRIBE brain model on Apple MPS...", flush=True)
    model = TribeModel.from_pretrained(checkpoint, cache_folder=str(cache / "features"),
        device="mps", config_update=config)
    # neuralset 0.0.2's schema predates MPS. Validate the full config first,
    # then change only these device fields before loading any encoder weights.
    # The outer cache records the backend (upstream excludes device from its UID).
    for extractor in [model.data.video_feature.image, model.data.audio_feature, model.data.text_feature]:
        object.__setattr__(extractor, "device", "mps")
        if extractor.device != "mps":
            raise RuntimeError("Could not route the extractor to MPS.")
    if model._model.device.type != "mps":
        raise RuntimeError("TRIBE did not load onto MPS.")
    stats = {"hits": 0, "misses": 0, "verification_forwards": 0}
    def verify_mps_equal(left, right):
        if left.device.type != "mps" or right.device.type != "mps":
            raise RuntimeError("V-JEPA forward did not execute on Apple MPS.")
        return torch.equal(left, right)
    install_exact_clip_cache(video_extractors, encoders["data.video_feature.image.model_name"],
        stats, verify_equal=verify_mps_equal)
    tribe_worker.MODEL = model
    from worker.still_image import StillImageExtractor
    print("MPS model ready; direct-still extraction with mandatory first-image MP4 parity check.", flush=True)
    return StillImageExtractor(model, spec, cache, stats), versions, stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--model-cache", type=Path, default=Path("data/huggingface"))
    args = parser.parse_args()
    if args.download_only:
        download_snapshots(args.model_cache)
    else:
        load_mps(model_cache=args.model_cache)
