"""Resumable Baseten extraction: download every pooled feature to local disk."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlparse
import zipfile

import numpy as np
import requests

from worker.affect_decoder import normalize_image, spec_hash
from training.baseten_auth import authorization_headers


def atomic_json(path, value):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def feature_paths(folder, item):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", item["id"]):
        raise ValueError("Unsafe feature ID.")
    return folder / (item["id"] + ".npz"), folder / (item["id"] + ".json")


def read_feature(folder, item, expected_spec_hash):
    feature, sidecar = feature_paths(folder, item)
    meta = json.loads(sidecar.read_text())
    data = feature.read_bytes()
    if (meta.get("id") != item["id"] or meta.get("media_hash") != item["media_hash"]
            or meta.get("feature_spec_hash") != expected_spec_hash
            or meta.get("artifact_sha256") != hashlib.sha256(data).hexdigest()):
        raise ValueError(f"Stale or corrupt feature cache for {item['id']}; use a fresh feature directory.")
    with np.load(io.BytesIO(data), allow_pickle=False) as cached:
        pooled = cached["pooled"]
    if pooled.ndim != 1 or not 1 <= len(pooled) <= 100_000 or not np.isfinite(pooled).all():
        raise ValueError("Invalid saved neural feature vector.")
    return pooled, meta


def save_result(folder, item, result, expected_spec_hash):
    metadata = result.get("metadata", {})
    if (result.get("id") != item["id"] or result.get("media_hash") != item["media_hash"]
            or metadata.get("feature_spec_hash") != expected_spec_hash):
        raise ValueError("Endpoint returned a different stimulus or feature specification.")
    encoded = result.get("pooled_f32_base64")
    dimension = result.get("feature_dim")
    if not isinstance(encoded, str) or len(encoded) > 600_000 or not isinstance(dimension, int) or not 1 <= dimension <= 100_000:
        raise ValueError("Invalid feature response dimensions.")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) != 4 * dimension or hashlib.sha256(raw).hexdigest() != result.get("pooled_sha256"):
        raise ValueError("Feature payload length or checksum mismatch.")
    pooled = np.frombuffer(raw, dtype="<f4").copy()
    if not np.isfinite(pooled).all():
        raise ValueError("Nonfinite neural output.")
    feature, sidecar = feature_paths(folder, item)
    buffer = io.BytesIO()
    np.savez_compressed(buffer, pooled=pooled)
    data = buffer.getvalue()
    temporary = feature.with_suffix(".npz.tmp")
    temporary.write_bytes(data)
    temporary.replace(feature)
    atomic_json(sidecar, {**metadata, "id": item["id"], "media_hash": item["media_hash"],
        "artifact_sha256": hashlib.sha256(data).hexdigest()})


def validate_endpoint(endpoint):
    endpoint_url = urlparse(endpoint)
    if (endpoint_url.scheme != "https" or not endpoint_url.hostname
            or not endpoint_url.hostname.endswith(".api.baseten.co")
            or endpoint_url.username or endpoint_url.password or endpoint_url.query
            or endpoint_url.fragment or endpoint_url.port not in (None, 443)
            or not endpoint_url.path.endswith("/predict")):
        raise ValueError("Use the HTTPS /predict URL from your Baseten deployment.")


def extract(manifest_path, folder, endpoint, api_key="", limit=None, timeout=900, *, auth_headers=None):
    validate_endpoint(endpoint)
    headers_for_request = auth_headers or authorization_headers(api_key)
    manifest_path, folder = Path(manifest_path), Path(folder)
    manifest = json.loads(manifest_path.read_text())
    expected = spec_hash()
    if manifest.get("feature_spec_hash") != expected:
        raise ValueError("Dataset preprocessing specification differs from the checked-in version.")
    archive = manifest_path.parent / manifest["archive"]
    with archive.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != manifest["archive_sha256"]:
            raise ValueError("Dataset archive checksum mismatch.")
    folder.mkdir(parents=True, exist_ok=True)
    done, elapsed, server_cached = 0, [], 0
    # Stable shuffled order gives a more varied first benchmark than alphabetic themes.
    ordered = sorted(manifest["items"], key=lambda row: hashlib.sha256(row["id"].encode()).hexdigest())
    with requests.Session() as session, zipfile.ZipFile(archive) as zipped:
        for item in ordered:
            feature, sidecar = feature_paths(folder, item)
            if feature.exists() and sidecar.exists():
                read_feature(folder, item, expected)
                done += 1
                continue
            if limit is not None and len(elapsed) >= limit:
                continue
            png = normalize_image(zipped.read(item["image_member"]))
            if hashlib.sha256(png).hexdigest() != item["media_hash"]:
                raise ValueError("Image preprocessing changed since manifest creation.")
            candidate = {"id": item["id"], "media_hash": item["media_hash"],
                         "png_base64": base64.b64encode(png).decode()}
            start = time.monotonic()
            response = session.post(endpoint, json={"action": "features", "candidates": [candidate]},
                                    headers=headers_for_request(), timeout=(30, timeout), allow_redirects=False)
            if response.status_code != 200:
                raise RuntimeError(f"Baseten HTTP {response.status_code}; inspect deployment logs. Completed features are saved; rerun to resume.")
            body = response.json()
            results = body.get("results", [])
            if body.get("feature_spec_hash") != expected or not isinstance(results, list) or len(results) != 1:
                raise ValueError("Unexpected Baseten feature contract.")
            save_result(folder, item, results[0], expected)
            elapsed.append(time.monotonic() - start)
            cached = bool(results[0].get("metadata", {}).get("cached"))
            server_cached += cached
            done += 1
            print(json.dumps({"id": item["id"], "completed": done, "seconds": round(elapsed[-1], 2), "server_cached": cached}), flush=True)
    summary = {"dataset_images": len(ordered), "completed": done, "network_calls": len(elapsed),
        "server_cache_hits": server_cached, "request_seconds": elapsed,
        "mean_seconds_after_first": float(np.mean(elapsed[1:])) if len(elapsed) > 1 else None,
        "note": "First request may include cold startup. Cached calls are not uncached throughput. No API keys are recorded."}
    atomic_json(folder / "extraction-summary.json", summary)
    print(json.dumps(summary, indent=2))
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("data/datasets/oasis/manifest-10s-v3.json"))
    parser.add_argument("--output", type=Path, default=Path("data/features/oasis-10s-v3"))
    parser.add_argument("--endpoint", default=os.environ.get("BASETEN_TRIBE_ENDPOINT", ""))
    parser.add_argument("--truss-remote", help="Use an existing Truss login (e.g. baseten), refreshing OAuth per request.")
    parser.add_argument("--limit", type=int, help="Maximum new network requests this invocation; start with 1, then 10.")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    from training.pause import require_experimental_resume
    require_experimental_resume()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    headers = authorization_headers(os.environ.get("BASETEN_API_KEY", ""), args.truss_remote)
    extract(args.manifest, args.output, args.endpoint, limit=args.limit, timeout=args.timeout, auth_headers=headers)


if __name__ == "__main__":
    main()
