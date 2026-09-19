"""Optional, serial GPU worker. Install the official TRIBE v2 package separately.

This adapter predicts brain activity and requires a separately fitted emotion
decoder to return emotion scores. No pretrained emotion decoder is supplied.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PROTOCOL = "static-png-30s-silent-no-asr-25fps-1024-mean-after5-v1"
LABELS = ["joy", "trust", "curiosity", "desire"]
CACHE = Path(os.environ.get("TRIBE_CACHE_DIR", "data/tribe-cache")).resolve()
REVISION = os.environ.get("TRIBE_MODEL_REVISION", "")
CODE_REVISION = os.environ.get("TRIBE_CODE_REVISION", "")
TOKEN = os.environ.get("TRIBE_TOKEN", "")
MODEL = None
DECODER = None
META = None


def load_decoder():
    global DECODER, META
    path = os.environ.get("TRIBE_DECODER_PATH")
    if not path:
        return
    import numpy as np
    head_path = Path(path)
    META = json.loads(head_path.with_suffix(".json").read_text())
    if (META.get("protocol") != PROTOCOL or META.get("model_revision") != REVISION
            or META.get("code_revision") != CODE_REVISION or META.get("labels") != LABELS
            or not META.get("validation_groups") or not META.get("version")
            or META.get("validation_status") != "held-out-product-groups"):
        raise ValueError("Decoder metadata does not match this model and protocol.")
    with np.load(head_path, allow_pickle=False) as data:
        DECODER = {name: data[name] for name in ["weights", "bias", "mean", "scale"]}
    w, b, mean, scale = [DECODER[key] for key in ["weights", "bias", "mean", "scale"]]
    if (w.ndim != 2 or w.shape[1] != 4 or b.shape != (4,) or mean.shape != (w.shape[0],)
            or scale.shape != mean.shape or not all(np.isfinite(x).all() for x in [w, b, mean, scale])
            or (scale <= 0).any()):
        raise ValueError("Invalid decoder tensor shapes or values.")


def model():
    global MODEL
    if MODEL is None:
        from tribev2 import TribeModel
        # A local, pinned snapshot prevents silently changing the checkpoint.
        checkpoint = Path(os.environ["TRIBE_CHECKPOINT_DIR"]).resolve()
        if not (checkpoint / "config.yaml").is_file() or not (checkpoint / "best.ckpt").is_file():
            raise ValueError("A local official checkpoint snapshot is required.")
        MODEL = TribeModel.from_pretrained(str(checkpoint), cache_folder=str(CACHE / "features"))
    return MODEL


def extract(candidate):
    import numpy as np
    encoded = candidate.get("png_base64")
    if not isinstance(encoded, str) or len(encoded) > 24_000_000:
        raise ValueError("Invalid PNG payload.")
    raw = base64.b64decode(encoded, validate=True)
    media_hash = hashlib.sha256(raw).hexdigest()
    if not raw.startswith(b"\x89PNG\r\n\x1a\n") or media_hash != candidate.get("media_hash"):
        raise ValueError("PNG content hash mismatch.")
    # Bound image dimensions before invoking the media decoder.
    width, height = int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if width != 1024 or height != 1024:
        raise ValueError("This calibration protocol requires a 1024 x 1024 PNG.")
    key = hashlib.sha256(f"{media_hash}:{REVISION}:{CODE_REVISION}:{PROTOCOL}".encode()).hexdigest()
    path = CACHE / "neural" / f"{key}.npz"
    start = time.monotonic()
    if path.exists():
        with np.load(path, allow_pickle=False) as cached:
            pooled, shape = cached["pooled"], cached["predictions"].shape
        return pooled, media_hash, path, {"cached": True, "shape": list(shape), "elapsed_seconds": time.monotonic() - start}
    with tempfile.TemporaryDirectory(prefix="ad-tribe-") as temp:
        png, video = Path(temp) / "ad.png", Path(temp) / "ad.mp4"
        png.write_bytes(raw)
        # ponytail: one controlled presentation; validate new protocols before adding them.
        subprocess.run([os.environ.get("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-loglevel", "error", "-y",
                        "-loop", "1", "-i", str(png), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                        "-t", "30", "-r", "25", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-shortest", str(video)], check=True, timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        loaded = model()
        import pandas as pd
        from tribev2.demo_utils import get_audio_and_text_events
        # The upstream helper explicitly supports audio_only: keep video + silent
        # audio events, skip expensive/hallucinated speech recognition on silence.
        events = get_audio_and_text_events(pd.DataFrame([{
            "type": "Video", "filepath": str(video), "start": 0,
            "timeline": "default", "subject": "default",
        }]), audio_only=True)
        predictions, segments = loaded.predict(events=events, verbose=False)
    predictions = np.asarray(predictions, dtype=np.float32)
    if predictions.ndim != 2 or predictions.shape[0] <= 5 or not np.isfinite(predictions).all():
        raise ValueError("Invalid or too-short TRIBE predictions.")
    # Protocol hypothesis, not a claim about a scientifically optimal emotion feature.
    pooled = predictions[5:].mean(axis=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, predictions=predictions, pooled=pooled)
    path.with_suffix(".json").write_text(json.dumps({"media_hash": media_hash, "model_revision": REVISION,
        "code_revision": CODE_REVISION, "protocol": PROTOCOL, "shape": list(predictions.shape),
        "segments": [str(segment) for segment in segments]}, indent=2))
    return pooled, media_hash, path, {"cached": False, "shape": list(predictions.shape), "elapsed_seconds": time.monotonic() - start}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *_args):
        pass  # Never log request bodies, access tokens, or product descriptions.

    def send_json(self, status, body):
        encoded = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass  # In-flight GPU calls finish/cache even if the client cancels.

    def do_GET(self):
        if self.path != "/health":
            return self.send_json(404, {"error": "Not found"})
        self.send_json(200, {"status": "fitted-experimental" if DECODER else "uncalibrated", "model_loaded": MODEL is not None,
                             "protocol": PROTOCOL, "decoder_version": META["version"] if META else None})

    def do_POST(self):
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
            return self.send_json(401, {"error": "Unauthorized"})
        if self.path not in ["/score", "/features"]:
            return self.send_json(404, {"error": "Not found"})
        if self.path == "/score" and DECODER is None:
            return self.send_json(503, {"error": "No calibrated emotion decoder configured; brain activity is not an emotion score."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 64_000_000:
                raise ValueError("Request too large or empty.")
            body = json.loads(self.rfile.read(length))
            candidates = body.get("candidates")
            if not isinstance(candidates, list) or not 1 <= len(candidates) <= 16:
                raise ValueError("Expected 1-16 candidates.")
            if self.path == "/score" and body.get("decoder_version") != META["version"]:
                return self.send_json(409, {"error": "Decoder version mismatch"})
            if len({c.get("id") for c in candidates}) != len(candidates) or any(not isinstance(c.get("id"), str) for c in candidates):
                raise ValueError("Invalid candidate IDs.")
            scores = []
            for candidate in candidates:
                pooled, media_hash, feature_path, metadata = extract(candidate)
                metadata.update({"model_revision": REVISION, "code_revision": CODE_REVISION, "protocol": PROTOCOL,
                                 "uncertainty": "not-estimated", "duration_seconds": 30})
                result = {"id": candidate["id"], "media_hash": media_hash, "metadata": metadata}
                if self.path == "/score":
                    import numpy as np
                    if pooled.shape != DECODER["mean"].shape:
                        raise ValueError("Decoder does not match neural feature size.")
                    predicted = ((pooled - DECODER["mean"]) / DECODER["scale"]) @ DECODER["weights"] + DECODER["bias"]
                    if not np.isfinite(predicted).all():
                        raise ValueError("Decoder returned nonfinite output.")
                    result.update({"emotions": dict(zip(LABELS, np.clip(predicted, 0, 100).tolist())), "confidence": None,
                        "provenance": f"TRIBE v2 neural features + experimental fitted decoder {META['version']}; estimated ratings, not measured viewer response"})
                    result["metadata"]["validation"] = META["validation_metrics"]
                else:
                    result["feature_file"] = str(feature_path)
                    result["provenance"] = "Uncalibrated TRIBE neural features; no emotion score"
                scores.append(result)
            self.send_json(200, {"decoder_version": META["version"] if META else None, "scores": scores})
        except (ValueError, KeyError, TypeError):
            self.send_json(400, {"error": "Invalid input, protocol mismatch, or invalid model output."})
        except Exception as error:
            # Type helps local debugging without exposing keys, paths, or provider internals.
            print(f"TRIBE request failed: {type(error).__name__}", flush=True)
            self.send_json(503, {"error": "TRIBE inference unavailable. Inspect the GPU environment and upstream preprocessing."})


if __name__ == "__main__":
    if not re.fullmatch(r"[a-f0-9]{40}", REVISION) or not re.fullmatch(r"[a-f0-9]{40}", CODE_REVISION):
        raise SystemExit("Set TRIBE_MODEL_REVISION and TRIBE_CODE_REVISION to pinned 40-character commit hashes.")
    host = os.environ.get("TRIBE_HOST", "127.0.0.1")
    if host not in ["127.0.0.1", "localhost", "::1"] and not TOKEN:
        raise SystemExit("Non-loopback binding requires TRIBE_TOKEN; use a private network/TLS proxy.")
    CACHE.mkdir(parents=True, exist_ok=True)
    load_decoder()
    print("TRIBE worker ready; emotion decoder " + ("configured" if DECODER else "NOT configured"), flush=True)
    # Serial requests avoid multiplying model copies or oversubscribing GPU memory.
    HTTPServer((host, int(os.environ.get("TRIBE_PORT", "8091"))), Handler).serve_forever()
