"""Validate and bundle a trained decoder for the next Baseten deployment."""
import argparse
import hashlib
from pathlib import Path
import shutil

from worker.affect_decoder import AffectDecoder


def package(source, destination):
    source, destination = Path(source), Path(destination)
    decoder = AffectDecoder(source)
    targets = [(source, destination / "decoder.npz"), (source.with_suffix(".json"), destination / "decoder.json")]
    for original, target in targets:
        if target.exists() and hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(original.read_bytes()).digest():
            raise ValueError(f"A different decoder is already bundled at {target}; move that pair aside before replacing it.")
    destination.mkdir(parents=True, exist_ok=True)
    for original, target in targets:
        shutil.copy2(original, target)
    print(f"Bundled {decoder.metadata['version']} in {destination}. Redeploy the model to load it.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--destination", type=Path, default=Path("deploy/baseten/data"))
    args = parser.parse_args()
    package(args.source, args.destination)
