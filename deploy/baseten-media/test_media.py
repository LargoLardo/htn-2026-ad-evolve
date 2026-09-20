"""Offline contract tests: real FFmpeg; no model download or provider calls."""
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
if not os.getenv('FFMPEG_BIN'):
    bundled = list((ROOT / 'data/venv-mps/lib/python3.11/site-packages/imageio_ffmpeg/binaries').glob('ffmpeg-*'))
    if bundled:
        os.environ['FFMPEG_BIN'] = str(bundled[0])
spec = importlib.util.spec_from_file_location('media_service', Path(__file__).parent / 'model/model.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

class MediaTests(unittest.TestCase):
    def payload(self, action):
        data = (ROOT / 'tests/fixtures/sample.mp4').read_bytes()
        return dict(action=action, media_hash=hashlib.sha256(data).hexdigest(), media_base64=base64.b64encode(data).decode())

    def test_inspect_and_six_frame_audio_review(self):
        model = service.Model()
        info = model.predict(self.payload('inspect'))
        self.assertTrue(1 <= info['duration'] <= 60)
        self.assertTrue(info['hasAudio'])
        result = model.predict(self.payload('review'))
        self.assertEqual(len(result['images']), 6)
        self.assertEqual([f['time'] for f in result['images']], [max(0, (info['duration'] - .1) * i / 5) for i in range(6)])
        self.assertTrue(all(base64.b64decode(f['base64']).startswith(b'\xff\xd8') for f in result['images']))
        self.assertTrue(base64.b64decode(result['audio']).startswith(b'RIFF'))
        self.assertEqual(result['scope'], 'six-sampled-frames-and-audio-transcript')
        self.assertIsNone(model.model)

    def test_rejects_tampering_invalid_media_and_actions(self):
        model = service.Model()
        request = self.payload('inspect'); request['media_hash'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'identity'): model.predict(request)
        with self.assertRaisesRegex(ValueError, 'Unknown'): model.predict(dict(action='fetch-url'))
        request['media_base64'] = base64.b64encode(b'bad video').decode()
        request['media_hash'] = hashlib.sha256(b'bad video').hexdigest()
        with self.assertRaisesRegex(ValueError, 'MP4'): model.predict(request)

if __name__ == '__main__': unittest.main()
