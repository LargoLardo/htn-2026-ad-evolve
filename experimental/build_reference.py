"""Build a frozen, label-free reference from existing features. No inference/downloads."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.io import loadmat

ROOT = Path(__file__).resolve().parents[1]
ATLAS_SHA = "b134426deb0fa553de8bcbea9d95c864763eee3701fb561cdee32435da27969d"
ATLAS_REV = "35b5664bec8822e2f77da5e090e96f91d0095be6"
NETWORKS = ["visual", "somatomotor", "dorsal_attention", "ventral_attention", "limbic", "control", "default"]
NAMES = ["Visual", "Somatomotor", "Dorsal attention", "Salience / ventral attention", "Limbic", "Control", "Default"]


def build(features, output):
    output = Path(output)
    if output.suffix != '.json':
        raise ValueError("Reference output must be a .json path.")
    if output.exists() or output.with_suffix('.sha256').exists():
        raise ValueError("Frozen references are immutable. Choose a new output path/version.")
    atlas_path = ROOT / "experimental/assets/yeo7-fsaverage5.mat"
    if hashlib.sha256(atlas_path.read_bytes()).hexdigest() != ATLAS_SHA:
        raise ValueError("Published atlas checksum mismatch.")
    atlas = loadmat(atlas_path)
    labels = np.concatenate([atlas["lh_labels"].ravel(), atlas["rh_labels"].ravel()]).astype(np.uint8)
    spec = json.loads((ROOT / "worker/affect_spec.json").read_text())
    spec_hash = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    vectors, records, contracts = [], [], []
    for path in sorted(Path(features).glob("*.npz")):
        meta = json.loads(path.with_suffix(".json").read_text())
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if meta.get("artifact_sha256") != digest or meta.get("feature_spec_hash") != spec_hash:
            raise ValueError(f"Feature integrity/specification mismatch: {path.name}")
        contract = {key: meta[key] for key in ["feature_spec_hash", "protocol", "model_revision", "code_revision", "runtime_versions", "execution_config"]}
        if contract["protocol"] != spec["protocol"] or contract["model_revision"] != spec["model_revision"] or contract["code_revision"] != spec["code_revision"]:
            raise ValueError("Feature protocol/revision mismatch.")
        contracts.append(contract)
        with np.load(path, allow_pickle=False) as arrays:
            vector = arrays["pooled"].astype(np.float64)
        if vector.shape != (20484,) or not np.isfinite(vector).all():
            raise ValueError("Expected finite fsaverage5 left-then-right features.")
        vectors.append(vector)
        records.append({"id": meta["id"], "media_hash": meta["media_hash"], "artifact_sha256": digest})
    if len(vectors) < 10 or len({row["media_hash"] for row in records}) != len(records):
        raise ValueError("Reference needs at least ten distinct cached images.")
    if any(contract != contracts[0] for contract in contracts):
        raise ValueError("Reference mixes inference runtimes or execution settings.")
    x = np.stack(vectors)
    mean, sd = x.mean(0).astype("<f4"), x.std(0)
    valid = (labels > 0) & (sd > 1e-6)
    labels[~valid] = 0  # Exclude medial wall and constant vertices.
    scale_floor = max(1e-6, float(np.median(sd[valid])) * .05)
    scale = np.maximum(sd, scale_floor).astype("<f4")
    z = (x[:, valid] - mean[valid].astype(float)) / scale[valid].astype(float)
    rms = np.sqrt(np.mean(z ** 2, axis=1))
    centered = z - z.mean(1, keepdims=True)
    norm = np.linalg.norm(centered, axis=1)
    if (norm < 1e-12).any():
        raise ValueError("Degenerate reference pattern.")
    maps = []
    for index, (key, name) in enumerate(zip(NETWORKS, NAMES), 1):
        mask = (labels[valid] == index).astype(float)
        mask -= mask.mean()
        correlations = np.einsum('ij,j->i', centered, mask / np.linalg.norm(mask), optimize=False) / norm
        maps.append({"key": key, "label": f"{name} network pattern", "index": index,
                     "reference_correlations": sorted(correlations.tolist())})
    artifact = {"schema": "evolve-network-reference-v1", "version": output.stem,
        "status": "experimental-unvalidated", "surface": "fsaverage5", "vertex_order": "left-then-right",
        "dimension": len(labels), "reference_count": len(x), "contract": contracts[0],
        "atlas": {"name": "Yeo 2011 7 networks", "sha256": ATLAS_SHA, "revision": ATLAS_REV,
            "source": f"https://github.com/ThomasYeoLab/CBIG/blob/{ATLAS_REV}/stable_projects/brain_parcellation/Yeo2011_fcMRI_clustering/1000subjects_reference/1000subjects_clusters007_ref.mat",
            "citation": "https://doi.org/10.1152/jn.00338.2011", "license": "CBIG MIT; experimental/assets/CBIG-LICENSE.md"},
        "method": "Frozen vertex standardization; spatial Pearson r against binary network maps; empirical midrank percentile.",
        "labels_used": False, "scale_floor": scale_floor, "max_reference_rms": float(max(rms)),
        "mean_f32": base64.b64encode(mean.tobytes()).decode(),
        "scale_f32": base64.b64encode(scale.tobytes()).decode(),
        "network_u8": base64.b64encode(labels.tobytes()).decode(), "maps": maps, "reference_images": records,
        "limitation": "Descriptive comparison to 60 OASIS photographs, not ad outcomes, emotion probabilities, significance, or validated attention. Includes former train/validation/test images without using their labels; not an independent evaluation."}
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(artifact, separators=(",", ":"), allow_nan=False) + "\n").encode()
    with output.open('xb') as handle:
        handle.write(encoded)
    with output.with_suffix('.sha256').open('x') as handle:
        handle.write(hashlib.sha256(encoded).hexdigest() + "\n")
    print(json.dumps({"path": str(output), "images": len(x), "vertices": int(valid.sum()), "bytes": len(encoded), "inference_calls": 0, "labels_used": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--features", type=Path, default=ROOT / "data/features/oasis-10s-v3")
    parser.add_argument("--output", type=Path, default=ROOT / "data/experimental/oasis60-yeo7-v1.json")
    args = parser.parse_args()
    build(args.features, args.output)
