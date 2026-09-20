"""Shared image/video inference path; model loading remains in the deployment."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

import numpy as np

try:
    from .percept_score import checked_predictions, decode_reference, encode_reference, parcel_traces, summarize
except ImportError:
    from percept_score import checked_predictions, decode_reference, encode_reference, parcel_traces, summarize

ROOT = Path(__file__).resolve().parent
MAX_BYTES = 50 * 1024 * 1024


def contract():
    raw = (ROOT / 'percept_spec.json').read_bytes()
    value = json.loads(raw)
    if hashlib.sha256((ROOT / 'assets/glasser-fsaverage5.json').read_bytes()).hexdigest() != value['atlas_sha256']:
        raise ValueError('Percept atlas does not match the scoring contract.')
    return value, hashlib.sha256(raw).hexdigest()


def ffmpeg(args):
    subprocess.run([os.environ.get('FFMPEG_BIN', 'ffmpeg'), '-nostdin', '-y', '-loglevel', 'error', *args],
        check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def image_video(image, output):
    from PIL import Image
    with Image.open(image) as source:
        if source.width * source.height > 16_777_216 or source.width < 16 or source.height < 16 or getattr(source, 'n_frames', 1) != 1:
            raise ValueError('Expected one still image, at most 16 megapixels.')
        source.convert('RGB').save(image)
    ffmpeg(['-loop', '1', '-i', str(image), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', '10', '-r', '25', '-c:v', 'libx264rgb', '-crf', '0', '-preset', 'ultrafast', '-pix_fmt', 'rgb24',
        '-c:a', 'aac', '-shortest', str(output)])


def validate_video(path):
    raw = subprocess.run([os.environ.get('FFPROBE_BIN', 'ffprobe'), '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)],
        check=True, timeout=30, capture_output=True).stdout
    info = json.loads(raw)
    video = next((s for s in info.get('streams', []) if s.get('codec_type') == 'video'), None)
    duration = float(info.get('format', {}).get('duration', 0))
    if not video or not 1 <= duration <= 60.1 or not 16 <= video.get('width', 0) <= 4096 or not 16 <= video.get('height', 0) <= 4096:
        raise ValueError('Use a 1–60 second video, with dimensions between 16 and 4096 pixels.')
    return info


def extract_media(candidate, model, cache, contract_hash, runtime):
    media_type = candidate.get('media_type')
    if media_type not in ['image', 'video']:
        raise ValueError('Expected image or video media_type.')
    encoded = candidate.get('media_base64', '')
    if not isinstance(encoded, str) or not 0 < len(encoded) <= (MAX_BYTES * 4 // 3 + 4):
        raise ValueError('Media is empty or exceeds 50 MiB.')
    raw = base64.b64decode(encoded, validate=True)
    if not 0 < len(raw) <= MAX_BYTES:
        raise ValueError('Media is empty or exceeds 50 MiB.')
    digest = hashlib.sha256(raw).hexdigest()
    if digest != candidate.get('media_hash'):
        raise ValueError('Media hash mismatch.')
    key = hashlib.sha256(json.dumps([digest, media_type, contract_hash, runtime], sort_keys=True).encode()).hexdigest()
    path = Path(cache) / 'percept' / f'{key}.npz'
    if path.exists():
        with np.load(path, allow_pickle=False) as saved:
            predictions = checked_predictions(saved['predictions'])
            tr = float(saved['tr'])
        return predictions, tr, True
    with tempfile.TemporaryDirectory(prefix='evolve-media-') as directory:
        folder = Path(directory)
        source = folder / 'source.mp4'
        if media_type == 'image':
            image = folder / 'still.png'
            image.write_bytes(raw)
            image_video(image, source)
        else:
            source.write_bytes(raw)
            validate_video(source)
        infer_path = folder / 'inference.mp4'
        # Match Percept's default shorter-side=256 preprocessing, preserving
        # aspect ratio and audio. Both still presentations and video use it.
        ffmpeg(['-i', str(source), '-vf', "scale='if(gt(iw,ih),-2,min(256,iw))':'if(gt(iw,ih),min(256,ih),-2)'",
            '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
            *(['-t', '10'] if media_type == 'image' else []), str(infer_path)])
        events = model.get_events_dataframe(video_path=str(infer_path))
        predictions, _ = model.predict(events, verbose=False)
        predictions = checked_predictions(predictions)
        tr = float(model.data.TR)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.npz', delete=False) as handle:
        temporary = Path(handle.name)
        np.savez_compressed(handle, predictions=predictions, tr=tr)
    temporary.replace(path)
    return predictions, tr, False


def score_batch(request, model, cache, runtime):
    spec, contract_hash = contract()
    if request.get('contract_hash') != contract_hash:
        raise ValueError('Percept scoring contract mismatch; update the worker and app together.')
    candidates = request.get('candidates')
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 4:
        raise ValueError('Send 1–4 candidates.')
    ids = [c.get('id') for c in candidates if isinstance(c, dict)]
    if len(ids) != len(candidates) or any(not isinstance(i, str) or not 0 < len(i) <= 200 for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('Candidate IDs must be unique.')
    baseline = request.get('baseline')
    reference = decode_reference(baseline, contract_hash, runtime) if baseline else None
    results = []
    for candidate in candidates:
        predictions, tr, cached = extract_media(candidate, model, cache, contract_hash, runtime)
        prediction_hash = hashlib.sha256(np.asarray(predictions, dtype='<f8').tobytes()).hexdigest()
        if baseline is None:
            baseline = encode_reference(predictions, candidate['media_hash'], prediction_hash, contract_hash, runtime)
            reference = decode_reference(baseline, contract_hash, runtime)
        score = summarize(predictions, reference, tr=tr)
        score.update(parcels=parcel_traces(predictions, reference),
            source='tribe-percept', contractHash=contract_hash, version=spec['version'],
            baselineHash=baseline['hash'], baselineMediaHash=baseline['mediaHash'], confidence=None,
            provenance='Percept scoring: original-media temporal z scores, bilateral Glasser parcel means, four equally weighted families. Predicted cortical response; not a validated emotion or conversion score.')
        results.append(dict(id=candidate['id'], media_hash=candidate['media_hash'], neural=score,
            metadata=dict(runtime_versions=runtime, prediction_hash=prediction_hash, cached=cached,
                protocol=spec['protocol'], percept_revision=spec['percept_revision'])))
    return dict(contract_hash=contract_hash, baseline=baseline, results=results)
