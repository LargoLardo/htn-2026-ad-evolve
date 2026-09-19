"""Fit a ridge decoder from consented human ad ratings; no synthetic labels.

Usage: python worker/calibrate.py labels.json output-head.npz VERSION
Manifest rows: {features: "...npz", product_group: "...", split: "train"|
"validation", ratings: {joy: 0..100, trust: ..., curiosity: ..., desire: ...}}
"""
import json
from pathlib import Path
import sys

import numpy as np

from tribe_worker import LABELS, PROTOCOL


def fit(manifest_path, output, version):
    rows = json.loads(Path(manifest_path).read_text())
    if not isinstance(rows, list) or len(rows) < 6:
        raise ValueError("Supply real rated creatives spanning training and held-out product groups.")
    features, ratings, info = [], [], []
    for row in rows:
        path = Path(row["features"])
        with np.load(path, allow_pickle=False) as cached:
            features.append(cached["pooled"])
        info.append(json.loads(path.with_suffix(".json").read_text()))
        ratings.append([row["ratings"][label] for label in LABELS])
        if row["split"] not in ["train", "validation"] or not row["product_group"]:
            raise ValueError("Each row needs a product group and explicit split.")
    protocols = {(item["model_revision"], item["code_revision"], item["protocol"]) for item in info}
    if len(protocols) != 1 or info[0]["protocol"] != PROTOCOL:
        raise ValueError("All features must use the same model and presentation protocol.")
    x, y = np.stack(features).astype(float), np.array(ratings, dtype=float)
    train = np.array([row["split"] == "train" for row in rows])
    train_groups = {row["product_group"] for row in rows if row["split"] == "train"}
    val_groups = {row["product_group"] for row in rows if row["split"] == "validation"}
    train_media = {item["media_hash"] for row, item in zip(rows, info) if row["split"] == "train"}
    val_media = {item["media_hash"] for row, item in zip(rows, info) if row["split"] == "validation"}
    if train_groups & val_groups or train_media & val_media or len(train_groups) < 2 or len(val_groups) < 2 or train.sum() < 3 or (~train).sum() < 3:
        raise ValueError("Use disjoint products and media, at least two groups and three creatives in each split. These are smoke-test minima, not a sufficient scientific sample.")
    if not np.isfinite(x).all() or not np.isfinite(y).all() or (y < 0).any() or (y > 100).any():
        raise ValueError("Features and 0-100 human ratings must be finite.")
    mean, scale = x[train].mean(axis=0), x[train].std(axis=0)
    scale[scale < 1e-6] = 1
    z, bias = (x[train] - mean) / scale, y[train].mean(axis=0)
    # Dual ridge avoids a ~20,000-by-20,000 inverse for small research datasets.
    alpha = 100.0
    weights = z.T @ np.linalg.solve(z @ z.T + alpha * np.eye(len(z)), y[train] - bias)
    predicted = np.clip(((x[~train] - mean) / scale) @ weights + bias, 0, 100)
    mae = np.abs(predicted - y[~train]).mean(axis=0)
    baseline_mae = np.abs(bias - y[~train]).mean(axis=0)
    output = Path(output)
    if output.suffix != ".npz" or not version.strip():
        raise ValueError("Output must end .npz and version must be nonempty.")
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, weights=weights, bias=bias, mean=mean, scale=scale)
    metadata = {"version": version, "labels": LABELS, "protocol": PROTOCOL,
        "model_revision": info[0]["model_revision"], "code_revision": info[0]["code_revision"],
        "validation_status": "held-out-product-groups", "training_groups": sorted(train_groups),
        "validation_groups": sorted(val_groups), "train_count": int(train.sum()), "validation_count": int((~train).sum()),
        "validation_metrics": {"mae": dict(zip(LABELS, mae.tolist())), "constant_baseline_mae": dict(zip(LABELS, baseline_mae.tolist()))},
        "uncertainty": "not-estimated", "ridge_alpha": alpha,
        "limitation": "A fitted research decoder, not proof of predictive validity. Review holdout metrics, ranking, sample size, and target-audience coverage before enabling selection."}
    output.with_suffix(".json").write_text(json.dumps(metadata, indent=2))
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    fit(*sys.argv[1:])
