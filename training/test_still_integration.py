"""Optional pinned-neuralset/FFmpeg integration checks; run in data/venv-mps.

No encoder downloads. The brain contract check uses synthetic sensory arrays,
not OASIS features, and never saves model outputs to the dataset.
"""
import io
import os
from pathlib import Path
import tempfile
import unittest

import imageio_ffmpeg
import numpy as np
from PIL import Image
import torch

from neuralset import base
from neuralset.events.utils import extract_events
from neuralset.extractors.base import HuggingFaceMixin
from tribev2 import TribeModel

from training.local_mps import SPEC_PATH
from worker.affect_decoder import load_spec
from worker.still_image import StillImageExtractor, repeated_frames
from worker.tribe_worker import MPS_FIVE_SECOND_PROTOCOL, predict_png_reference


class StillIntegrationTests(unittest.TestCase):
    def test_memory_frames_match_lossless_video_and_audio_is_silence(self):
        os.environ["FFMPEG_BIN"] = imageio_ffmpeg.get_ffmpeg_exe()
        os.environ["IMAGEIO_FFMPEG_EXE"] = os.environ["FFMPEG_BIN"]
        y, x = np.indices((1024, 1024))
        pixels = np.stack([x % 256, y % 256, (x + y) % 256], axis=-1).astype(np.uint8)
        stream = io.BytesIO()
        Image.fromarray(pixels).save(stream, format="PNG")
        frames = repeated_frames(stream.getvalue())
        checked = {}
        def predict(events, verbose=False):
            for event in extract_events(events):
                if event.type == "Video":
                    clip = event.read()
                    try:
                        times = {max(0, t - k / 64 * 4) for t in np.linspace(0, 5, 11)[1:] for k in range(64)}
                        for t in sorted(times):
                            np.testing.assert_array_equal(clip.get_frame(t), frames[0])
                        checked["video_times"] = len(times)
                    finally:
                        clip.close()
                elif event.type == "Audio":
                    wave = event.read()
                    self.assertEqual(event.duration, 5)
                    self.assertEqual(len(wave), round(5 * event.frequency))
                    self.assertTrue(torch.equal(wave, torch.zeros_like(wave)))
                    checked["audio"] = True
            return None, None
        class InspectMedia:
            pass
        loaded = InspectMedia()
        loaded.predict = predict
        predict_png_reference(stream.getvalue(), loaded, MPS_FIVE_SECOND_PROTOCOL)
        self.assertGreater(checked["video_times"], 10)
        self.assertTrue(checked["audio"])

    @unittest.skipUnless(torch.backends.mps.is_available(), "Requires Apple MPS")
    def test_actual_brain_contract_with_synthetic_sensory_arrays(self):
        spec = load_spec(SPEC_PATH)
        root = Path("data/huggingface").resolve()
        checkpoint = root / "models--facebook--tribev2/snapshots" / spec["model_revision"]
        if not (checkpoint / "best.ckpt").exists():
            self.skipTest("Pinned brain checkpoint not downloaded")
        config = {"data.num_workers": 0}
        for field, encoder in spec["encoders"].items():
            path = str(root / ("models--" + encoder["repo"].replace("/", "--")) / "snapshots" / encoder["revision"])
            if path not in HuggingFaceMixin._REPOS:
                HuggingFaceMixin._REPOS.append(path)
            config[field] = path
        for field in ("data.video_feature.image.device", "data.audio_feature.device", "data.text_feature.device"):
            config[field] = "cpu"
        torch.set_num_threads(4)
        with tempfile.TemporaryDirectory(prefix="still-contract-test-") as folder:
            model = TribeModel.from_pretrained(checkpoint, cache_folder=folder, device="mps", config_update=config)
            adapter = StillImageExtractor(model, spec, folder, {})
            arrays = {name: base.TimedArray(data=np.zeros((20, width, 10), dtype=np.float32), frequency=2,
                start=base._UNSET_START, duration=5) for name, width in [("video", 1408), ("audio", 1024)]}
            preds, segments = adapter._predict(arrays, "synthetic-contract-test-only")
            self.assertEqual(preds.shape, (5, 20484))
            self.assertTrue(np.isfinite(preds).all())
            self.assertEqual([(s.start, s.duration) for s in segments], [(float(t), 1.0) for t in range(5)])
            self.assertNotIn("_get_data", model.data.video_feature.__dict__)


if __name__ == "__main__":
    unittest.main()
