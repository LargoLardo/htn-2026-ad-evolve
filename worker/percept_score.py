"""Independent implementation of Percept's published scoring mathematics.

Parity target: edrlu/Percept worker/app.py at 000f26d529e0b87b2478142bd8b5ebf40e44e313.
No fitted decoder, spatial correlations, reference photograph percentiles or Yeo maps.
"""
import base64
import hashlib
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
FAMILIES = [
    ('auditory_engagement', 'Auditory / speech-music', 'AUD', '#ffb13b', 'high', ['A1', 'MBelt', 'LBelt', 'PBelt', 'A4', 'A5', 'STG*', 'STS*']),
    ('language_message', 'Language / message', 'LANG', '#ff5a7a', 'high', ['44', '45', '47l', 'IFS*', 'IFJ*']),
    ('attention_salience', 'Attention + salience', 'ATTN', '#9b8cff', 'medium', ['IPS*', 'LIP*', 'VIP', 'FEF', '6a', 'AVI', 'MI', 'FOP*', 'a24pr', 'p24pr', 'PFm', 'PGi', 'PGs', 'TPOJ*']),
    ('visual_motion', 'Visual / motion', 'VIS', '#3fd6c0', 'medium', ['MT', 'MST', 'V4t', 'FST', 'LO*', 'V3CD']),
]


def load_atlas():
    path = ROOT / 'assets/glasser-fsaverage5.json'
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != path.with_suffix('.sha256').read_text().strip():
        raise ValueError('Glasser atlas checksum mismatch.')
    return {name: np.asarray(indices, dtype=np.int64) for name, indices in json.loads(raw)['parcels'].items()}


def family_parcels(atlas):
    groups = []
    for *_, patterns in FAMILIES:
        names = set()
        for pattern in patterns:
            matched = [name for name in atlas if name.startswith(pattern[:-1])] if pattern.endswith('*') else [name for name in atlas if name.endswith(pattern[1:])] if pattern.startswith('*') else [name for name in atlas if name == pattern]
            names.update(matched)  # Some published patterns match no current atlas parcel, as in Percept.
        groups.append({name: atlas[name] for name in sorted(names)})
    if any(not group or any(not len(v) for v in group.values()) for group in groups):
        raise ValueError('Empty Percept family or parcel.')
    return groups


def checked_predictions(predictions):
    values = np.asarray(predictions, dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != 20484 or not 1 <= values.shape[0] <= 120 or not np.isfinite(values).all():
        raise ValueError('Expected finite time x 20484 cortical predictions (1–120 time points).')
    return values


def reference_stats(predictions):
    values = checked_predictions(predictions)
    return values.mean(axis=0), np.maximum(values.std(axis=0), 1e-6)


def summarize(predictions, reference=None, atlas=None, tr=1.0):
    values = checked_predictions(predictions)
    mu, sd = reference if reference is not None else reference_stats(values)
    z = (values - np.asarray(mu).reshape(1, -1)) / np.maximum(np.asarray(sd).reshape(1, -1), 1e-6)
    groups = family_parcels(load_atlas() if atlas is None else atlas)
    # Match Percept's float64 normalization, float32 traces, then Python/NumPy
    # rounding. Overall uses the already rounded family scores.
    traces = np.empty((4, len(values)), dtype=np.float32)
    for index, parcels in enumerate(groups):
        regional = np.stack([z[:, indices].mean(axis=1) for indices in parcels.values()])
        traces[index] = np.clip(50.0 * (1.0 + regional.mean(axis=0) / 2.0), 0, 100)
    regions = []
    series = {}
    for index, (key, name, short, color, reliability, _) in enumerate(FAMILIES):
        trace = np.round(traces[index], 1).tolist()
        series[key] = trace
        regions.append(dict(key=key, name=name, short=short, color=color, reliability=reliability,
            score=round(float(traces[index].mean()), 1), values=trace))
    global_trace = traces.mean(axis=0)
    overall = round(float(np.mean([r['score'] for r in regions])), 1)
    regions.sort(key=lambda r: r['score'], reverse=True)
    peak = int(np.argmax(global_trace))
    return dict(duration=round(len(values) * tr, 2), frames=len(values), engagementScore=overall,
        regions=regions, cognitiveSeries=series, **{'global': np.round(global_trace, 2).tolist()},
        peak=dict(time=round(peak * tr, 2), label=regions[0]['short'], value=round(float(global_trace[peak]), 2)))


def encode_reference(predictions, media_hash, prediction_hash, contract_hash, runtime):
    mean, sd = reference_stats(predictions)
    raw = np.stack([mean, sd]).astype('<f8').tobytes()
    metadata = dict(mediaHash=media_hash, predictionHash=prediction_hash, contractHash=contract_hash,
        runtimeVersions=runtime, statsSha256=hashlib.sha256(raw).hexdigest())
    digest = hashlib.sha256(json.dumps(metadata, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    return {**metadata, 'hash': digest, 'statsF64': base64.b64encode(raw).decode()}


def decode_reference(reference, contract_hash, runtime):
    if reference.get('contractHash') != contract_hash or reference.get('runtimeVersions') != runtime:
        raise ValueError('Original reference protocol or runtime mismatch.')
    raw = base64.b64decode(reference['statsF64'], validate=True)
    metadata = {key: reference[key] for key in ['mediaHash', 'predictionHash', 'contractHash', 'runtimeVersions', 'statsSha256']}
    if len(raw) != 2 * 20484 * 8 or hashlib.sha256(raw).hexdigest() != reference['statsSha256'] or hashlib.sha256(json.dumps(metadata, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest() != reference['hash']:
        raise ValueError('Original reference checksum mismatch.')
    values = np.frombuffer(raw, dtype='<f8').reshape(2, 20484)
    if not np.isfinite(values).all() or (values[1] < 1e-6).any():
        raise ValueError('Invalid original reference statistics.')
    return values[0], values[1]
