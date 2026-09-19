"""Fit on train, select alpha on validation, and evaluate a frozen head on test."""
import argparse
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from scipy.stats import rankdata

from training.extract_features import atomic_json, read_feature
from worker.affect_decoder import LABELS, fit_ridge, load_spec, predict, spec_hash


def correlations(a, b):
    if np.std(a) == 0 or np.std(b) == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def metrics(y, predicted, baseline):
    return {label: {"mae": float(np.abs(y[:, i] - predicted[:, i]).mean()),
        "rmse": float(np.sqrt(np.square(y[:, i] - predicted[:, i]).mean())),
        "pearson": correlations(y[:, i], predicted[:, i]),
        "spearman": correlations(rankdata(y[:, i]), rankdata(predicted[:, i])),
        "constant_baseline_mae": float(np.abs(y[:, i] - baseline[i]).mean())}
        for i, label in enumerate(LABELS)}


def load_dataset(manifest_path, folder, feature_spec=None):
    expected_spec_hash = spec_hash(feature_spec)
    manifest = json.loads(Path(manifest_path).read_text())
    if (manifest.get("labels") != LABELS or manifest.get("rating_scale") != [0, 100]
            or manifest.get("feature_spec_hash") != expected_spec_hash):
        raise ValueError("Dataset label/feature specification mismatch.")
    rows = manifest["items"]
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate image IDs.")
    partitions = {split: [row for row in rows if row["split"] == split] for split in ["train", "validation", "test"]}
    if sum(map(len, partitions.values())) != len(rows):
        raise ValueError("Unknown dataset split.")
    for split, items in partitions.items():
        if len(items) < 3 or len({row["group"] for row in items}) < 2:
            raise ValueError(f"{split} needs at least 3 images in 2 groups; these are code-test minima, not sufficient scientific sample sizes.")
    for key in ["group", "media_hash", "source_sha256"]:
        used = set()
        for items in partitions.values():
            values = {row[key] for row in items}
            if used & values:
                raise ValueError(f"Train/validation/test leakage in {key}.")
            used.update(values)
    loaded = [read_feature(Path(folder), row, expected_spec_hash) for row in rows]
    runtime_versions = {json.dumps(meta.get("runtime_versions", {}), sort_keys=True) for _, meta in loaded}
    if len(runtime_versions) != 1:
        raise ValueError("Feature files mix different inference-library versions; extract into a fresh directory.")
    x = np.stack([pooled for pooled, _ in loaded]).astype(float)
    y = np.array([[row["ratings"][label] for label in LABELS] for row in rows], dtype=float)
    if not np.isfinite(y).all() or (y < 0).any() or (y > 100).any():
        raise ValueError("Ratings must be finite and within 0–100.")
    return manifest, rows, x, y, json.loads(runtime_versions.pop())


def train(manifest_path, folder, output, version, alphas=(.1, 1, 10, 100, 1000, 10000), *, feature_spec=None):
    feature_spec = feature_spec or load_spec()
    output = Path(output)
    if output.suffix != ".npz" or not version.strip():
        raise ValueError("Provide an .npz output and nonempty decoder version.")
    if output.exists() or output.with_suffix(".json").exists():
        raise ValueError("Decoder artifacts are versioned; choose a new output path.")
    manifest, rows, x, y, runtime_versions = load_dataset(manifest_path, folder, feature_spec)
    masks = {split: np.array([row["split"] == split for row in rows]) for split in ["train", "validation", "test"]}
    trials, best = [], None
    for alpha in alphas:
        head = fit_ridge(x[masks["train"]], y[masks["train"]], float(alpha))
        validation_mae = float(np.abs(predict(head, x[masks["validation"]]) - y[masks["validation"]]).mean())
        trials.append({"alpha": float(alpha), "validation_mean_mae": validation_mae})
        if best is None or validation_mae < best[0]:
            best = (validation_mae, float(alpha), head)
    if best is None:
        raise ValueError("Supply at least one regularization value.")
    _, alpha, head = best
    # Freeze the selected head before ever looking at test labels. Do not refit.
    predictions = predict(head, x)
    validation = metrics(y[masks["validation"]], predictions[masks["validation"]], head["bias"])
    test = metrics(y[masks["test"]], predictions[masks["test"]], head["bias"])
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **head)
    artifact = buffer.getvalue()
    metadata = {"schema_version": 1, "version": version, "labels": LABELS, "rating_scale": [0, 100],
        "feature_spec": feature_spec, "feature_spec_hash": spec_hash(feature_spec),
        "runtime_versions": runtime_versions,
        "artifact_sha256": hashlib.sha256(artifact).hexdigest(),
        "manifest_sha256": hashlib.sha256(Path(manifest_path).read_bytes()).hexdigest(),
        "dataset": manifest["dataset"], "selected_alpha": alpha, "validation_trials": trials,
        "pilot": manifest.get("pilot"),
        "counts": {split: int(mask.sum()) for split, mask in masks.items()},
        "groups": {split: sorted({row["group"] for row in rows if row["split"] == split}) for split in masks},
        "validation_metrics": validation, "test_metrics": test,
        "test_beats_constant_baseline": {label: test[label]["mae"] < test[label]["constant_baseline_mae"] for label in LABELS},
        "validation_status": "held-out-image-groups-experimental",
        "uncertainty": "not-estimated",
        "limitation": "Predicts average OASIS valence/arousal ratings from simulated cortical features. Not validated on ads, the target audience, or matched exposure durations. Compare with image-embedding baselines. Never tune against this test report."}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(artifact)
    atomic_json(output.with_suffix(".json"), metadata)
    atomic_json(output.with_suffix(".predictions.json"), [
        {"id": row["id"], "split": row["split"], "group": row["group"],
         "ratings": row["ratings"], "predictions": dict(zip(LABELS, values.tolist()))}
        for row, values in zip(rows, predictions)])
    print(json.dumps({"decoder": str(output), "selected_alpha": alpha, "test": test,
        "test_beats_constant_baseline": metadata["test_beats_constant_baseline"]}, indent=2))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("data/datasets/oasis/manifest-10s-v3.json"))
    parser.add_argument("--features", type=Path, default=Path("data/features/oasis-10s-v3"))
    parser.add_argument("--output", type=Path, default=Path("data/decoder/oasis-10s-v3.npz"))
    parser.add_argument("--version", default="oasis-10s-valence-arousal-v3")
    parser.add_argument("--spec", type=Path)
    args = parser.parse_args()
    from training.pause import require_experimental_resume
    require_experimental_resume()
    train(args.manifest, args.features, args.output, args.version, feature_spec=load_spec(args.spec))


if __name__ == "__main__":
    main()
