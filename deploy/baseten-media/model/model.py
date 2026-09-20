"""Private media inference service. No URLs, training, or TRIBE dependencies."""
import base64
import hashlib
import json
import math
import os
import re
from pathlib import Path
import subprocess
import tempfile

MAX_BYTES = 50 * 1024 * 1024


def ffmpeg(*args):
    return subprocess.run([os.getenv("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-hide_banner", "-y", *map(str, args)],
                          capture_output=True, check=True, timeout=180)


def inspect(path):
    result = subprocess.run([os.getenv("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-hide_banner", "-i", str(path)], capture_output=True, timeout=30)
    stderr = result.stderr.decode(errors="replace")
    dimensions = re.search(r"Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b", stderr)
    time = re.search(r"Duration: (\d+):(\d+):([\d.]+)", stderr)
    width, height = map(int, dimensions.groups()) if dimensions else (0, 0)
    duration = int(time[1]) * 3600 + int(time[2]) * 60 + float(time[3]) if time else 0
    if "Input #0, mov,mp4" not in stderr or not math.isfinite(duration) or not 1 <= duration <= 60.1 or not all(16 <= n <= 4096 for n in [width, height]):
        raise ValueError("Upload an MP4 between 1 and 60 seconds, with dimensions between 16 and 4096.")
    return dict(width=width, height=height, duration=duration, hasAudio="Audio:" in stderr)


def review(path, directory):
    info, images = inspect(path), []
    for i in range(6):
        time = max(0, (info["duration"] - 0.1) * i / 5)
        target = directory / f"{i}.jpg"
        ffmpeg("-loglevel", "error", "-ss", time, "-i", path, "-frames:v", "1", "-vf", "scale=768:768:force_original_aspect_ratio=decrease", "-q:v", "3", target)
        images.append(dict(time=time, base64=base64.b64encode(target.read_bytes()).decode()))
    audio = None
    if info["hasAudio"]:
        target = directory / "speech.wav"
        ffmpeg("-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", target)
        audio = base64.b64encode(target.read_bytes()).decode()
    return dict(images=images, audio=audio, scope="six-sampled-frames-and-audio-transcript")


class Model:
    def __init__(self, **kwargs):
        self.model = None

    def load(self):
        # Once per replica; keep the exact float64 finalizer and uniform prior.
        from deepgaze_pytorch import DeepGazeIIE
        self.model = DeepGazeIIE(pretrained=True).to("cpu").eval()

    def predict(self, request):
        action = request.get("action")
        if action not in ("inspect", "review", "attention"):
            raise ValueError("Unknown media action.")
        encoded = request.get("media_base64")
        if not isinstance(encoded, str) or len(encoded) > 4 * math.ceil(MAX_BYTES / 3):
            raise ValueError("Media exceeds 50 MiB.")
        media = base64.b64decode(encoded, validate=True)
        if not media or len(media) > MAX_BYTES or hashlib.sha256(media).hexdigest() != request.get("media_hash"):
            raise ValueError("Media identity mismatch.")
        with tempfile.TemporaryDirectory(prefix="advolve-media-") as directory:
            directory = Path(directory)
            path = directory / ("input.png" if action == "attention" else "input.mp4")
            path.write_bytes(media)
            if action == "inspect":
                return inspect(path)
            if action == "review":
                return review(path, directory)
            from saliency import load_image, saliency, to_grid, write_heatmap
            grid = request.get("grid", 3)
            if not isinstance(grid, int) or not 2 <= grid <= 16:
                raise ValueError("Grid must be between 2 and 16.")
            if self.model is None:
                raise RuntimeError("Attention model was not loaded.")
            density = saliency(load_image(path), "cpu", model=self.model)
            target = directory / "attention.png"
            write_heatmap(density, target)
            return dict(source="deepgaze-iie", device="cpu", grid=grid,
                        width=int(density.shape[1]), height=int(density.shape[0]),
                        centerbias="uniform", map=to_grid(density, grid),
                        heatmap=base64.b64encode(target.read_bytes()).decode(),
                        provenance="DeepGaze IIE predicted fixation density with a uniform centerbias. Predicted gaze, not measured eye tracking.")
