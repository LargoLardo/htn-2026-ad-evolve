"""Score a real image through the deployed experimental Baseten affect decoder.

This makes one paid inference request. It does not train, deploy, or retry.
"""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import time

import requests

from training.baseten_auth import authorization_headers
from training.extract_features import validate_endpoint
from worker.affect_decoder import LABELS, normalize_image, spec_hash


def score_image(raw, endpoint, decoder_version, *, auth_headers, timeout=900):
    validate_endpoint(endpoint)
    if not isinstance(decoder_version, str) or not decoder_version.strip():
        raise ValueError("Specify the exact deployed decoder version.")
    png = normalize_image(raw)
    media_hash = hashlib.sha256(png).hexdigest()
    candidate_id = "image-" + media_hash[:16]
    candidate = {"id": candidate_id, "media_hash": media_hash,
                 "png_base64": base64.b64encode(png).decode()}
    start = time.monotonic()
    response = requests.post(endpoint, headers=auth_headers(),
        json={"action": "score", "decoder_version": decoder_version, "candidates": [candidate]},
        timeout=(30, timeout), allow_redirects=False)
    if response.status_code != 200:
        raise RuntimeError(f"Baseten HTTP {response.status_code}; inspect deployment logs. No automatic retry was made.")
    body = response.json()
    results = body.get("results")
    if (body.get("feature_spec_hash") != spec_hash()
            or body.get("decoder_version") != decoder_version
            or not isinstance(results, list) or len(results) != 1):
        raise ValueError("Unexpected Baseten scorer version or feature specification.")
    result = results[0]
    if (result.get("id") != candidate_id or result.get("media_hash") != media_hash
            or result.get("metadata", {}).get("feature_spec_hash") != spec_hash()):
        raise ValueError("Endpoint returned scores for a different stimulus or protocol.")
    scores = result.get("affect")
    if (not isinstance(scores, dict) or set(scores) != set(LABELS)
            or any(isinstance(value, bool) or not isinstance(value, (int, float))
                   or not math.isfinite(value) or not 0 <= value <= 100
                   for value in scores.values())):
        raise ValueError("Endpoint returned invalid valence/arousal scores.")
    return {**body, "request_seconds": time.monotonic() - start}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--decoder-version", required=True)
    parser.add_argument("--endpoint", default=os.environ.get("BASETEN_TRIBE_ENDPOINT", ""))
    parser.add_argument("--truss-remote")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    headers = authorization_headers(os.environ.get("BASETEN_API_KEY", ""), args.truss_remote)
    result = score_image(args.image.read_bytes(), args.endpoint, args.decoder_version,
                         auth_headers=headers, timeout=args.timeout)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
