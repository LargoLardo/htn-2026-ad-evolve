"""Resumable 5-second OASIS extraction on the local Apple GPU; no cloud calls."""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import time
import traceback
import zipfile

import numpy as np

from training.extract_features import atomic_json, feature_paths, read_feature, save_result
from training.local_mps import SPEC_PATH, load_mps
from worker.affect_decoder import load_spec, normalize_image, spec_hash


def on_ac_power():
    if platform.system() != "Darwin":
        return False
    result = subprocess.run(["/usr/bin/pmset", "-g", "batt"], capture_output=True, text=True, check=True)
    return "'AC Power'" in result.stdout


def extract_local(manifest_path, folder, *, limit=None, max_minutes=None, allow_battery=False, loader=load_mps):
    manifest_path, folder = Path(manifest_path), Path(folder)
    spec = load_spec(SPEC_PATH)
    expected = spec_hash(spec)
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("feature_spec_hash") != expected or manifest.get("feature_spec") != spec:
        raise ValueError(f"Use a separate manifest prepared with {SPEC_PATH.name}.")
    archive = manifest_path.parent / manifest["archive"]
    with archive.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != manifest["archive_sha256"]:
            raise ValueError("Dataset archive checksum mismatch.")
    ordered = sorted(manifest["items"], key=lambda row: hashlib.sha256(row["id"].encode()).hexdigest())
    if len({row["id"] for row in ordered}) != len(ordered):
        raise ValueError("Duplicate image IDs.")
    folder.mkdir(parents=True, exist_ok=True)
    pending, done = [], 0
    saved_versions = set()
    for item in ordered:
        feature, sidecar = feature_paths(folder, item)
        if feature.exists() and sidecar.exists():
            _, meta = read_feature(folder, item, expected)
            saved_versions.add(json.dumps(meta.get("runtime_versions"), sort_keys=True))
            done += 1
        else:
            pending.append(item)
    elapsed, stop_reason = [], "complete"
    print(json.dumps({"saved": done, "pending": len(pending), "protocol": spec["protocol"]}), flush=True)
    if pending:
        if not allow_battery and not on_ac_power():
            raise RuntimeError("Connect the Mac to AC power before local GPU extraction (or explicitly pass --allow-battery).")
        worker, versions, stats = loader()
        if saved_versions and saved_versions != {json.dumps(versions, sort_keys=True)}:
            raise ValueError("Existing features use a different local runtime; use a fresh directory.")
        import torch
        started = time.monotonic()
        with zipfile.ZipFile(archive) as zipped:
            for item in pending:
                if limit is not None and len(elapsed) >= limit:
                    stop_reason = "request-limit"
                    break
                if max_minutes is not None and time.monotonic() - started >= max_minutes * 60:
                    stop_reason = "time-limit"
                    break
                if not allow_battery and not on_ac_power():
                    stop_reason = "disconnected-from-AC"
                    break
                png = normalize_image(zipped.read(item["image_member"]))
                if hashlib.sha256(png).hexdigest() != item["media_hash"]:
                    raise ValueError("Image preprocessing differs from manifest.")
                candidate = {"id": item["id"], "media_hash": item["media_hash"],
                    "png_base64": base64.b64encode(png).decode()}
                before = dict(stats)
                start = time.monotonic()
                pooled, media_hash, _, metadata = worker.extract(candidate)
                torch.mps.synchronize()
                if metadata.get("shape") != [5, 20484] or metadata.get("duration_seconds") != 5:
                    raise ValueError("Expected five real TRIBE samples with 20,484 vertices each.")
                raw = np.asarray(pooled, dtype="<f4").tobytes()
                metadata = {**metadata, "feature_spec_hash": expected, "runtime_versions": versions,
                    "protocol": spec["protocol"], "model_revision": spec["model_revision"],
                    "code_revision": spec["code_revision"], "execution_backend": spec["execution_backend"],
                    "clip_cache": {key: value - before.get(key, 0) for key, value in stats.items()},
                    "mps_allocated_bytes": torch.mps.current_allocated_memory(),
                    "mps_driver_allocated_bytes": torch.mps.driver_allocated_memory(),
                    "uncertainty": "not-estimated"}
                save_result(folder, item, {"id": item["id"], "media_hash": media_hash, "metadata": metadata,
                    "feature_dim": len(pooled), "pooled_f32_base64": base64.b64encode(raw).decode(),
                    "pooled_sha256": hashlib.sha256(raw).hexdigest()}, expected)
                done += 1
                elapsed.append(time.monotonic() - start)
                # Keep reusable allocator pages between images. Purge periodically
                # to bound accumulation without forcing allocations on every image.
                if done % 25 == 0:
                    torch.mps.empty_cache()
                progress = {"id": item["id"], "completed": done, "total": len(ordered),
                    "seconds": round(elapsed[-1], 2), "cached": metadata["cached"],
                    "mps_driver_gib": round(metadata["mps_driver_allocated_bytes"] / 2**30, 2)}
                atomic_json(folder / "progress.json", progress)
                print(json.dumps(progress), flush=True)
    summary = {"completed": done, "dataset_images": len(ordered), "new_extractions": len(elapsed),
        "request_seconds": elapsed, "mean_seconds": float(np.mean(elapsed)) if elapsed else None,
        "stop_reason": stop_reason, "complete": done == len(ordered),
        "note": "Local MPS only. First extraction may include encoder loading. Resume with the same command."}
    atomic_json(folder / "local-extraction-summary.json", summary)
    print(json.dumps(summary, indent=2), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("data/datasets/oasis/subset300-still5s-mps-v5.json"))
    parser.add_argument("--output", type=Path, default=Path("data/features/oasis-still5s-mps-v5"))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--max-minutes", type=float, help="Stop between images after this much inference time.")
    parser.add_argument("--allow-battery", action="store_true")
    parser.add_argument("--train-when-complete", action="store_true")
    parser.add_argument("--decoder", type=Path, default=Path("data/decoder/oasis300-still5s-mps-v5.npz"))
    parser.add_argument("--version", default="oasis300-still5s-mps-valence-arousal-v5")
    parser.add_argument("--log-file", type=Path, help="Append progress and errors to this local log.")
    args = parser.parse_args()
    from training.pause import require_experimental_resume
    require_experimental_resume()
    if args.train_when_complete:
        parser.error("Automatic decoder training is disabled. Review extracted features and run the archived trainer separately.")
    if args.limit is not None and args.limit < 1 or args.max_minutes is not None and args.max_minutes <= 0:
        parser.error("Limits must be positive.")
    lock_path = Path("data/tribe-mps/.run.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.ExitStack() as stack:
        lock = stack.enter_context(lock_path.open("a"))
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another local MPS run holds the GPU lock; inspect it before starting a second.")
        if args.log_file:
            args.log_file.parent.mkdir(parents=True, exist_ok=True)
            print(f"Local run logging to {args.log_file}", flush=True)
            log = stack.enter_context(args.log_file.open("a", buffering=1))
            stack.enter_context(contextlib.redirect_stdout(log))
            stack.enter_context(contextlib.redirect_stderr(log))
        try:
            summary = extract_local(args.manifest, args.output, limit=args.limit,
                max_minutes=args.max_minutes, allow_battery=args.allow_battery)
        except BaseException:
            traceback.print_exc()
            raise


if __name__ == "__main__":
    main()
