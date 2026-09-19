"""Download/prepare OASIS; split by theme, exact content and near-duplicate images."""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path
import random
import re
import urllib.request
import zipfile

import numpy as np
from PIL import Image
from scipy.fft import dctn

from worker.affect_decoder import load_spec, normalize_image, spec_hash

URL = "https://benedekkurdi.com/oasis.php"
ARCHIVE_SHA256 = "d17ff678cc9b2da5b0ff042c1ba3f1df16399b11f7e92e8706c277c82202bf8f"


def perceptual_hash(raw):
    with Image.open(io.BytesIO(raw)) as image:
        gray = np.asarray(image.convert("L").resize((32, 32), Image.Resampling.LANCZOS))
    coefficients = dctn(gray.astype(float), norm="ortho")[:8, :8].ravel()[1:]
    return sum(int(bit) << i for i, bit in enumerate(coefficients > np.median(coefficients)))


def assign_splits(rows, seed):
    parent = list(range(len(rows)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    matches = []
    for i, row in enumerate(rows):
        for j in range(i):
            other = rows[j]
            similar = (int(row["perceptual_hash"], 16) ^ int(other["perceptual_hash"], 16)).bit_count() <= 4
            if row["theme_group"] == other["theme_group"] or row["media_hash"] == other["media_hash"] or similar:
                parent[root(i)] = root(j)
                if similar and row["theme_group"] != other["theme_group"]:
                    matches.append([other["id"], row["id"]])
    groups = defaultdict(list)
    for i, row in enumerate(rows):
        groups[root(i)].append(row)
    ordered = list(groups.values())
    random.Random(seed).shuffle(ordered)
    if len(ordered) < 3:
        raise ValueError("Need at least three independent image groups.")
    # Approximate 70/15/15 by whole groups; never split a creative family.
    train_end = min(max(1, int(len(ordered) * .70)), len(ordered) - 2)
    boundaries = [train_end, min(max(train_end + 1, int(len(ordered) * .85)), len(ordered) - 1)]
    for i, group in enumerate(ordered):
        split = "train" if i < boundaries[0] else "validation" if i < boundaries[1] else "test"
        group_id = min(row["id"] for row in group)
        for row in group:
            row.update(group=group_id, split=split)
    return matches


def prepare(archive, output, seed=42, feature_spec=None):
    feature_spec = feature_spec or load_spec()
    archive, output = Path(archive).resolve(), Path(output).resolve()
    with archive.open("rb") as handle:
        checksum = hashlib.file_digest(handle, "sha256").hexdigest()
    if checksum != ARCHIVE_SHA256:
        raise ValueError("OASIS archive changed. Review its provenance before updating the pinned checksum.")
    rows = []
    with zipfile.ZipFile(archive) as zipped:
        raw_rows = list(csv.DictReader(io.StringIO(zipped.read("OASIS.csv").decode("utf-8-sig"))))
        if len(raw_rows) != 900:
            raise ValueError("Expected the 900-image OASIS release.")
        for raw_row in raw_rows:
            item_id, theme = raw_row[""], raw_row["Theme"].strip()
            if not re.fullmatch(r"I\d+", item_id):
                raise ValueError("Unexpected image ID.")
            member = f"Images/{theme}.jpg"
            raw = zipped.read(member)
            png = normalize_image(raw)
            ratings = {label: float(raw_row[label.title() + "_mean"]) for label in ["valence", "arousal"]}
            if not all(np.isfinite(value) and 1 <= value <= 7 for value in ratings.values()):
                raise ValueError("Unexpected OASIS rating scale.")
            rows.append({"id": item_id, "image_member": member, "theme": theme,
                "theme_group": re.sub(r"\s+\d+$", "", theme).casefold(),
                "category": raw_row["Category"], "source": raw_row["Source"],
                "source_sha256": hashlib.sha256(raw).hexdigest(), "media_hash": hashlib.sha256(png).hexdigest(),
                "perceptual_hash": f"{perceptual_hash(raw):016x}", "original_ratings": ratings,
                "ratings": {key: (value - 1) * 100 / 6 for key, value in ratings.items()},
                "rating_counts": {label: int(raw_row[label.title() + "_N"]) for label in ratings}})
    matches = assign_splits(rows, seed)
    import os
    manifest = {"schema_version": 1, "dataset": "OASIS", "source_url": URL,
        "citation": "Kurdi, Lozano & Banaji (2017), doi:10.3758/s13428-016-0715-3",
        "archive": os.path.relpath(archive, output.parent), "archive_sha256": checksum,
        "feature_spec": feature_spec, "feature_spec_hash": spec_hash(feature_spec),
        "labels": ["valence", "arousal"], "original_scale": [1, 7], "rating_scale": [0, 100],
        "seed": seed, "split_method": "whole-theme/exact-image/pHash-distance<=4-connected-groups",
        "cross_theme_similar_pairs": matches, "split_counts": dict(Counter(row["split"] for row in rows)),
        "limitation": "OASIS ratings are not ad-specific and were not collected under the TRIBE static-video protocol. Grouping cannot guarantee all similar images are detected.",
        "items": rows}
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and json.loads(output.read_text()) != manifest:
        raise ValueError("Refusing to change an existing experiment manifest; choose a new output path.")
    output.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"manifest": str(output), "images": len(rows), "splits": manifest["split_counts"],
        "groups": len({row["group"] for row in rows}), "cross_theme_similar_pairs": len(matches)}, indent=2))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=Path("data/datasets/oasis/oasis.zip"))
    parser.add_argument("--output", type=Path, default=Path("data/datasets/oasis/manifest-10s-v3.json"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--spec", type=Path, help="Explicit feature protocol; default is the Baseten 10-second specification.")
    args = parser.parse_args()
    if args.download and not args.archive.exists():
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        partial = args.archive.with_suffix(".download")
        with urllib.request.urlopen(URL, timeout=60) as response, partial.open("wb") as out:
            import shutil
            shutil.copyfileobj(response, out)
        partial.rename(args.archive)
    prepare(args.archive, args.output, args.seed, feature_spec=load_spec(args.spec))


if __name__ == "__main__":
    main()
