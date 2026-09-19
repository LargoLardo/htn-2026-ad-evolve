"""Select a label-blind, one-image-per-group budget pilot without changing splits."""
import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path

from training.extract_features import atomic_json
from worker.affect_decoder import load_spec, spec_hash


def make_pilot(source, output, counts, seed=17, feature_spec=None, group_balanced=False):
    source, output = Path(source).resolve(), Path(output).resolve()
    raw = source.read_bytes()
    manifest = json.loads(raw)
    if manifest["feature_spec_hash"] != spec_hash(feature_spec):
        raise ValueError("Source uses a different feature protocol.")
    if output.exists():
        raise ValueError("Pilot manifests are frozen; choose a new output path.")
    group_splits = defaultdict(set)
    for row in manifest["items"]:
        group_splits[row["group"]].add(row["split"])
    if any(len(splits) != 1 for splits in group_splits.values()):
        raise ValueError("Source splits contain overlapping groups.")
    if len({row["id"] for row in manifest["items"]}) != len(manifest["items"]):
        raise ValueError("Source has duplicate image IDs.")
    items = []
    def order(value):
        return hashlib.sha256(f"{seed}:{value}".encode()).hexdigest()
    for split in ["train", "validation", "test"]:
        groups = defaultdict(list)
        for row in manifest["items"]:
            if row["split"] == split:
                groups[row["group"]].append(row)
        count = counts[split]
        maximum = sum(map(len, groups.values())) if group_balanced else len(groups)
        if not 3 <= count <= maximum:
            raise ValueError(f"{split}: request 3–{maximum} images within original groups.")
        selected = sorted(groups, key=lambda group: order(f"{split}:{group}"))
        ranked = [sorted(groups[group], key=lambda row: order(row["id"])) for group in selected]
        # Label-blind round-robin: one image per group before taking second
        # images. Never move images/groups to a different train/validation/test split.
        candidates = [rows[rank] for rank in range(max(map(len, ranked)) if group_balanced else 1)
                      for rows in ranked if rank < len(rows)]
        items.extend(candidates[:count])
    result = {**manifest, "dataset": "OASIS budget pilot", "items": items,
        "archive": os.path.relpath(source.parent / manifest["archive"], output.parent),
        "split_counts": counts,
        "pilot": {"parent_manifest_sha256": hashlib.sha256(raw).hexdigest(),
            "source_images": len(manifest["items"]), "seed": seed,
            "selection": "SHA256 order by seed/group/ID; " + ("group-balanced round-robin" if group_balanced else "one image per distinct group") + "; original splits retained; no labels or features used",
            "limitation": "Small budget-limited feasibility pilot. Test estimates have high uncertainty; not evidence of ad effectiveness."}}
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output, result)
    print(json.dumps({"manifest": str(output), "images": len(items), "split_counts": counts}, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/datasets/oasis/manifest-10s-v3.json"))
    parser.add_argument("--output", type=Path, default=Path("data/datasets/oasis/pilot60-10s-v3.json"))
    parser.add_argument("--train", type=int, default=40)
    parser.add_argument("--validation", type=int, default=10)
    parser.add_argument("--test", type=int, default=10)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--spec", type=Path)
    parser.add_argument("--group-balanced", action="store_true", help="Allow multiple images per group using label-blind round-robin; retain original splits.")
    args = parser.parse_args()
    make_pilot(args.source, args.output, {split: getattr(args, split) for split in ["train", "validation", "test"]}, args.seed,
               feature_spec=load_spec(args.spec), group_balanced=args.group_balanced)


if __name__ == "__main__":
    main()
