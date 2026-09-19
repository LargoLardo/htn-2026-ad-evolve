"""Direct still adapter tests. No model downloads or persisted synthetic data."""
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock

import numpy as np
from PIL import Image

from training.local_mps import SPEC_PATH
from training.make_pilot import make_pilot
from worker.affect_decoder import load_spec, spec_hash
from worker.clip_cache import install_exact_clip_cache
from worker.still_image import StillImageExtractor, compare_arrays, override_data, repeated_frames
from worker.tribe_worker import MPS_STILL_PROTOCOL, pool_predictions


class StillTests(unittest.TestCase):
    def test_reference_and_direct_calls_share_one_resident_encoder(self):
        class FakeVideo:
            MODELS = ("vjepa2",)
            def __init__(self, *args):
                pass
        module = types.SimpleNamespace(_HFVideoModel=FakeVideo)
        install_exact_clip_cache(module, "pinned", {})
        direct = module._HFVideoModel("pinned", True, "", None)
        reference = module._HFVideoModel(model_name="pinned", pretrained=True, layer_type="", num_frames=None)
        self.assertIs(direct, reference)
        direct.clear_exact_clip_cache()
        self.assertIsNone(direct._evolve_output)

    def test_repeat_rgb_without_allocating_64_frames(self):
        raw = io.BytesIO()
        pixels = np.arange(9 * 11 * 3, dtype=np.uint8).reshape(9, 11, 3)
        Image.fromarray(pixels).save(raw, format="PNG")
        frames = repeated_frames(raw.getvalue())
        self.assertEqual(frames.shape, (64, 9, 11, 3))
        self.assertEqual(frames.strides[0], 0)
        for frame in frames:
            np.testing.assert_array_equal(frame, pixels)
        resized = repeated_frames(raw.getvalue(), max_imsize=5)
        np.testing.assert_array_equal(resized[0], np.asarray(Image.fromarray(pixels).resize((5, 4))))

    def test_instance_override_restored_even_on_failure(self):
        class Extractor:
            def _get_data(self, events):
                return ["original"]
        one, two = Extractor(), Extractor()
        with self.assertRaisesRegex(ValueError, "test"):
            with override_data(one, lambda events: ["memory"]):
                self.assertEqual(one._get_data([]), ["memory"])
                self.assertEqual(two._get_data([]), ["original"])
                raise ValueError("test")
        self.assertEqual(one._get_data([]), ["original"])
        self.assertNotIn("_get_data", one.__dict__)

    def test_override_handles_upstream_read_only_property(self):
        class Extractor:
            @property
            def _get_data(self):
                return lambda events: iter(["descriptor"])
        one, two = Extractor(), Extractor()
        descriptor = Extractor.__dict__["_get_data"]
        original = one._get_data
        with override_data(one, lambda events: iter(["memory", *original(events)])):
            self.assertEqual(list(one._get_data([])), ["memory", "descriptor"])
            self.assertEqual(list(two._get_data([])), ["descriptor"])
        self.assertIs(Extractor.__dict__["_get_data"], descriptor)

    def test_parity_fails_closed_and_v5_pooling(self):
        a = np.ones((5, 3), dtype=np.float32)
        self.assertTrue(compare_arrays(a, a, "fixture")["exact_equal"])
        for b in [a[:2], a + .001, a * np.nan]:
            with self.assertRaisesRegex(RuntimeError, "parity"):
                compare_arrays(a, b, "fixture")
        np.testing.assert_array_equal(pool_predictions(a, MPS_STILL_PROTOCOL), a.mean(0))

    def test_failed_parity_never_saves_features(self):
        raw = io.BytesIO()
        Image.new("RGB", (1024, 1024)).save(raw, format="PNG")
        candidate = {"png_base64": base64.b64encode(raw.getvalue()).decode(),
            "media_hash": hashlib.sha256(raw.getvalue()).hexdigest()}
        with tempfile.TemporaryDirectory() as tmp:
            adapter = StillImageExtractor.__new__(StillImageExtractor)
            adapter.cache, adapter.parity = Path(tmp), None
            adapter._video_array = Mock(return_value=None)
            adapter._audio_array = Mock(return_value=None)
            adapter._predict = Mock(return_value=(np.zeros((5, 20484), dtype=np.float32), []))
            adapter._verify_reference = Mock(side_effect=RuntimeError("parity failed"))
            with self.assertRaisesRegex(RuntimeError, "parity failed"), contextlib.redirect_stdout(io.StringIO()):
                adapter.extract(candidate)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_300_subset_group_balanced_label_blind_and_original_splits(self):
        spec = load_spec(SPEC_PATH)
        items = [dict(id=f"{split}-{group}-{i}", group=f"{split}-{group}", split=split,
            ratings={"valence": i, "arousal": group})
            for split in ("train", "validation", "test") for group in range(30) for i in range(10)]
        counts = dict(train=210, validation=45, test=45)
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            folder = Path(tmp)
            source = folder / "source.json"
            data = dict(items=items, feature_spec_hash=spec_hash(spec), archive="images.zip")
            source.write_text(json.dumps(data))
            result = make_pilot(source, folder / "one.json", counts, feature_spec=spec, group_balanced=True)
            for row in items:
                row["ratings"] = {"valence": 99999, "arousal": -99999}
            source.write_text(json.dumps(data))
            again = make_pilot(source, folder / "two.json", counts, feature_spec=spec, group_balanced=True)
            self.assertEqual([r["id"] for r in result["items"]], [r["id"] for r in again["items"]])
            self.assertEqual(len(result["items"]), 300)
            for split, count in counts.items():
                rows = [r for r in result["items"] if r["split"] == split]
                self.assertEqual(len(rows), count)
                self.assertEqual(len({r["group"] for r in rows[:30]}), 30)
            data["items"][0]["group"] = "test-0"
            source.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "overlapping groups"):
                make_pilot(source, folder / "bad.json", counts, feature_spec=spec, group_balanced=True)


if __name__ == "__main__":
    unittest.main()
