"""Portable valence/arousal head; importing this module does not load TRIBE."""
import hashlib
import io
import json
from pathlib import Path

import numpy as np

LABELS = ["valence", "arousal"]
SPEC_PATH = Path(__file__).with_name("affect_spec.json")


def load_spec(path=None):
    return json.loads(Path(path or SPEC_PATH).read_text())


def spec_hash(spec=None):
    return hashlib.sha256(json.dumps(spec or load_spec(), sort_keys=True).encode()).hexdigest()


def normalize_image(raw):
    """Preserve the complete image and aspect ratio on a neutral square canvas."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(raw)) as source:
        source.load()
        image = ImageOps.exif_transpose(source).convert("RGB")
        image = ImageOps.contain(image, (1024, 1024), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (1024, 1024), (127, 127, 127))
        canvas.paste(image, ((1024 - image.width) // 2, (1024 - image.height) // 2))
    output = io.BytesIO()
    canvas.save(output, format="PNG")
    return output.getvalue()


def fit_ridge(x, y, alpha):
    if not np.isfinite(alpha) or alpha <= 0:
        raise ValueError("Ridge regularization must be positive and finite.")
    mean, scale = x.mean(axis=0), x.std(axis=0)
    scale[scale < 1e-6] = 1
    z, bias = (x - mean) / scale, y.mean(axis=0)
    # Dual ridge scales with number of images instead of ~20k cortical vertices.
    # Explicit contractions avoid spurious floating-point flags observed in
    # macOS Accelerate's wide matrix products. These agree with the original
    # products to numerical precision; the small solve still uses LAPACK.
    gram = np.einsum("ij,kj->ik", z, z, optimize=False)
    dual = np.linalg.solve(gram + alpha * np.eye(len(z)), y - bias)
    weights = np.einsum("ij,ik->jk", z, dual, optimize=False)
    return {"weights": weights, "bias": bias, "mean": mean, "scale": scale}


def predict(head, x):
    standardized = (x - head["mean"]) / head["scale"]
    return np.clip(np.einsum("...j,jk->...k", standardized, head["weights"], optimize=False) + head["bias"], 0, 100)


class AffectDecoder:
    def __init__(self, path, expected_spec=None):
        path = Path(path)
        self.metadata = json.loads(path.with_suffix(".json").read_text())
        if (self.metadata.get("labels") != LABELS
                or self.metadata.get("feature_spec_hash") != spec_hash(expected_spec)
                or self.metadata.get("rating_scale") != [0, 100]
                or not self.metadata.get("version")):
            raise ValueError("Decoder label schema or feature specification does not match.")
        if hashlib.sha256(path.read_bytes()).hexdigest() != self.metadata.get("artifact_sha256"):
            raise ValueError("Decoder artifact checksum mismatch.")
        with np.load(path, allow_pickle=False) as data:
            self.head = {key: data[key] for key in ["weights", "bias", "mean", "scale"]}
        w, b, m, s = [self.head[key] for key in ["weights", "bias", "mean", "scale"]]
        if (w.ndim != 2 or w.shape[1] != len(LABELS) or b.shape != (len(LABELS),)
                or m.shape != (w.shape[0],) or s.shape != m.shape or (s <= 0).any()
                or not all(np.isfinite(tensor).all() for tensor in self.head.values())):
            raise ValueError("Invalid decoder tensors.")

    def score(self, pooled):
        pooled = np.asarray(pooled)
        if pooled.shape != self.head["mean"].shape or not np.isfinite(pooled).all():
            raise ValueError("Invalid features for this decoder.")
        result = predict(self.head, pooled)
        if not np.isfinite(result).all():
            raise ValueError("Nonfinite decoder output.")
        return dict(zip(LABELS, result.tolist()))
