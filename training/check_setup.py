"""Report local readiness without printing secrets or making paid requests."""
import importlib.metadata
import json
import os
from pathlib import Path
import sys

from training.extract_features import read_feature
from worker.affect_decoder import load_spec, spec_hash


def main():
    manifest_path = Path("data/datasets/oasis/manifest-10s-v3.json")
    features_dir = Path("data/features/oasis-10s-v3")
    checks = {"python": sys.version.split()[0], "packages": {},
        "baseten_api_key_in_environment": bool(os.environ.get("BASETEN_API_KEY")),
        "baseten_endpoint_in_environment": bool(os.environ.get("BASETEN_TRIBE_ENDPOINT")),
        "dataset_ready": False, "real_features_ready": 0,
        "decoder_bundled": Path("deploy/baseten/data/decoder.npz").is_file(),
        "feature_spec_hash": spec_hash(), "model_revision": load_spec()["model_revision"]}
    for name in ["numpy", "scipy", "Pillow", "requests", "PyYAML"]:
        checks["packages"][name] = importlib.metadata.version(name)
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        checks["dataset_ready"] = manifest.get("feature_spec_hash") == spec_hash()
        checks["dataset_images"] = len(manifest["items"])
        checks["splits"] = manifest["split_counts"]
        for item in manifest["items"]:
            if (features_dir / (item["id"] + ".json")).is_file():
                read_feature(features_dir, item, spec_hash())
                checks["real_features_ready"] += 1
    print(json.dumps(checks, indent=2))
    print("Hugging Face gated access and Baseten credits must be checked in your accounts. No deployment or inference was performed.")


if __name__ == "__main__":
    main()
