"""Offline score parity and transport checks. Never loads model weights."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
from worker import percept_score as scoring
from worker import percept_worker as worker


class PerceptTests(unittest.TestCase):
    def test_exact_upstream_score_parity(self):
        fixture = json.loads((Path(__file__).resolve().parents[1] / 'tests/fixtures/percept-oracle.json').read_text())
        base = np.random.default_rng(fixture['base_seed']).normal(size=(10, 20484)).astype(np.float32)
        for case in fixture['cases']:
            values = np.random.default_rng(case['seed']).normal(size=(case['frames'], 20484)).astype(np.float32) + case['shift']
            ref = None if case['self_reference'] else scoring.reference_stats(base)
            actual = scoring.summarize(values, ref)
            for region in actual['regions']:
                region.pop('key')
            actual['source'] = 'model'
            self.assertEqual(actual, case['expected'])

    def test_parcels_are_bilateral_and_balanced(self):
        atlas = scoring.load_atlas()
        self.assertEqual(len(atlas), 180)
        self.assertTrue(all((v < 10242).any() and (v >= 10242).any() for v in atlas.values()))
        groups = scoring.family_parcels(atlas)
        self.assertTrue(all(groups))
        original = np.tile(np.linspace(-1, 1, 10)[:, None], (1, 20484))
        ref = scoring.reference_stats(original)
        self.assertEqual(scoring.summarize(original, ref)['engagementScore'], 50)
        self.assertGreater(scoring.summarize(original + .5, ref)['engagementScore'], 50)
        self.assertEqual(scoring.summarize(original + .5)['engagementScore'], 50)
        self.assertEqual(scoring.summarize(np.ones((1, 20484)))['engagementScore'], 50)

    def test_reference_roundtrip_rejects_corruption_and_runtime_changes(self):
        x = np.ones((10, 20484), dtype=np.float32)
        ref = scoring.encode_reference(x, 'media', 'pred', 'contract', {'torch': 'test'})
        mu, sd = scoring.decode_reference(ref, 'contract', {'torch': 'test'})
        np.testing.assert_array_equal(mu, 1)
        np.testing.assert_array_equal(sd, 1e-6)
        for changed in [dict(ref, statsF64='AA=='), dict(ref, mediaHash='other')]:
            with self.assertRaises(ValueError): scoring.decode_reference(changed, 'contract', {'torch': 'test'})
        with self.assertRaises(ValueError): scoring.decode_reference(ref, 'contract', {'torch': 'changed'})

    def test_batch_uses_one_original_for_different_length_takes(self):
        spec, digest = worker.contract()
        x = np.tile(np.linspace(-1, 1, 10)[:, None], (1, 20484))
        items = [dict(id='original', media_hash='a'), dict(id='take', media_hash='b')]
        with patch.object(worker, 'extract_media', side_effect=[(x, 1, False), (x[:6] + 2, 1, False)]):
            result = worker.score_batch(dict(contract_hash=digest, candidates=items), object(), Path('/unused'), {'test': 'v1'})
        self.assertEqual(result['baseline']['mediaHash'], 'a')
        self.assertEqual(result['results'][0]['neural']['engagementScore'], 50)
        self.assertGreater(result['results'][1]['neural']['engagementScore'], 50)
        self.assertEqual(result['results'][1]['neural']['frames'], 6)
        self.assertEqual(result['results'][0]['neural']['baselineHash'], result['results'][1]['neural']['baselineHash'])

    def test_media_cache_avoids_inference_and_is_contract_bound(self):
        raw = b'test-only-media'
        item = dict(media_type='video', media_hash=hashlib.sha256(raw).hexdigest(), media_base64=base64.b64encode(raw).decode())
        runtime = {'test': 'v1'}
        key = hashlib.sha256(json.dumps([item['media_hash'], 'video', 'contract', runtime], sort_keys=True).encode()).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'percept' / f'{key}.npz'
            path.parent.mkdir()
            np.savez(path, predictions=np.ones((12, 20484)), tr=1)
            values, tr, cached = worker.extract_media(item, None, Path(tmp), 'contract', runtime)
            self.assertEqual(values.shape, (12, 20484))
            self.assertTrue(cached)
            self.assertEqual(tr, 1)
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            worker.extract_media(dict(item, media_hash='wrong'), None, Path('/unused'), 'contract', runtime)

    def test_image_and_video_share_event_assembly_and_scoring(self):
        class FakeModel:
            data = types.SimpleNamespace(TR=1)
            def __init__(self): self.paths = []
            def get_events_dataframe(self, video_path): self.paths.append(video_path); return 'events-with-ASR'
            def predict(self, events, verbose):
                self.asserted_events = events
                return np.ones((10, 20484)), []
        model = FakeModel()
        raw = b'test-only'
        for media_type in ['image', 'video']:
            with tempfile.TemporaryDirectory() as tmp, patch.object(worker, 'image_video') as image_video, patch.object(worker, 'validate_video'), patch.object(worker, 'ffmpeg') as ffmpeg:
                candidate = dict(media_type=media_type, media_hash=hashlib.sha256(raw).hexdigest(), media_base64=base64.b64encode(raw).decode())
                worker.extract_media(candidate, model, tmp, 'contract', {})
                self.assertEqual(image_video.call_count, int(media_type == 'image'))
                self.assertIn('scale=', ' '.join(ffmpeg.call_args.args[0]))
                self.assertEqual(model.asserted_events, 'events-with-ASR')
        self.assertEqual(len(model.paths), 2)

    def test_real_image_video_conversion_and_downscale_without_model_weights(self):
        root = Path(__file__).resolve().parents[1]
        bundled = list((root / 'data/venv-mps/lib/python3.11/site-packages/imageio_ffmpeg/binaries').glob('ffmpeg-*'))
        executable = os.environ.get('FFMPEG_BIN') or shutil.which('ffmpeg') or (str(bundled[0]) if bundled else None)
        if not executable:
            self.skipTest('FFmpeg is required for this media integration check.')
        inspections = []
        class FakeModel:
            data = types.SimpleNamespace(TR=1)
            def get_events_dataframe(self, video_path):
                inspected = subprocess.run([executable, '-hide_banner', '-i', video_path], capture_output=True, text=True)
                inspections.append(inspected.stderr)
                return 'events'
            def predict(self, events, verbose): return np.ones((10, 20484)), []
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, FFMPEG_BIN=executable):
            path = Path(tmp) / 'wide.png'
            Image.new('RGB', (1024, 512), 'red').save(path)
            raw = path.read_bytes()
            candidate = dict(media_type='image', media_hash=hashlib.sha256(raw).hexdigest(), media_base64=base64.b64encode(raw).decode())
            values, _, cached = worker.extract_media(candidate, FakeModel(), tmp, 'contract', {})
            self.assertEqual(values.shape, (10, 20484))
            self.assertFalse(cached)
        self.assertIn('Duration: 00:00:10.00', inspections[0])
        self.assertIn('512x256', inspections[0])
        self.assertIn('Audio: aac', inspections[0])


if __name__ == '__main__': unittest.main()
