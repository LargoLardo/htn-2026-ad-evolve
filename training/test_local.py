"""Local MPS protocol/transport tests; no GPU, model downloads or cloud calls."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import zipfile

import numpy as np
from PIL import Image

from training.extract_features import read_feature, save_result
from training.extract_local import extract_local
from training.local_mps import SPEC_PATH
from training.test_training import fixture, result_for
from training.train_decoder import train
from worker.affect_decoder import AffectDecoder, load_spec, normalize_image, spec_hash
from worker.tribe_worker import MPS_FIVE_SECOND_PROTOCOL, MPS_STILL_PROTOCOL, SHORT_LOSSLESS_PROTOCOL, pool_predictions, protocol_options


class LocalTests(unittest.TestCase):
    def test_five_seconds_pool_all_and_legacy_still_discards_five(self):
        x = np.arange(20, dtype=np.float32).reshape(10, 2)
        self.assertEqual(protocol_options(MPS_FIVE_SECOND_PROTOCOL), (5, True))
        np.testing.assert_array_equal(pool_predictions(x[:5], MPS_FIVE_SECOND_PROTOCOL), x[:5].mean(0))
        np.testing.assert_array_equal(pool_predictions(x, SHORT_LOSSLESS_PROTOCOL), x[5:].mean(0))
        with self.assertRaises(ValueError):
            pool_predictions(x[:5], SHORT_LOSSLESS_PROTOCOL)
        x[0, 0] = np.nan
        with self.assertRaises(ValueError):
            pool_predictions(x, MPS_FIVE_SECOND_PROTOCOL)

    def test_explicit_spec_prevents_mixing_decoders(self):
        spec = load_spec(SPEC_PATH)
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            folder = Path(tmp)
            manifest, features, rows = fixture(folder)
            data = json.loads(manifest.read_text())
            data.update(feature_spec=spec, feature_spec_hash=spec_hash(spec))
            manifest.write_text(json.dumps(data))
            for row in rows:
                vector, _ = read_feature(features, row, spec_hash())
                result = result_for(row, vector)
                result["metadata"]["feature_spec_hash"] = spec_hash(spec)
                save_result(features, row, result, spec_hash(spec))
            with self.assertRaisesRegex(ValueError, "specification"):
                train(manifest, features, folder / "wrong.npz", "fixture-only")
            output = folder / "right.npz"
            metadata = train(manifest, features, output, "fixture-only", feature_spec=spec)
            self.assertEqual(metadata["feature_spec"], spec)
            AffectDecoder(output, expected_spec=spec)
            with self.assertRaisesRegex(ValueError, "schema"):
                AffectDecoder(output)

    def test_local_extraction_saves_real_contract_and_resumes_without_loading_gpu(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            folder = Path(tmp)
            raw = io.BytesIO()
            Image.new("RGB", (40, 30), (1, 2, 3)).save(raw, format="PNG")
            png = normalize_image(raw.getvalue())
            item = {"id": "I1", "image_member": "one.png", "media_hash": hashlib.sha256(png).hexdigest()}
            archive = folder / "images.zip"
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("one.png", raw.getvalue())
            spec = load_spec(SPEC_PATH)
            manifest = folder / "manifest.json"
            manifest.write_text(json.dumps({"items": [item], "archive": "images.zip",
                "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "feature_spec": spec, "feature_spec_hash": spec_hash(spec)}))
            worker = types.SimpleNamespace(extract=Mock(return_value=(np.ones(20484, dtype=np.float32), item["media_hash"], None,
                {"shape": [5, 20484], "duration_seconds": 5, "cached": False})))
            loader = Mock(return_value=(worker, {"runtime": "synthetic-test-only"}, {"hits": 0, "misses": 0}))
            mps = types.SimpleNamespace(synchronize=lambda: None, empty_cache=lambda: None,
                current_allocated_memory=lambda: 1, driver_allocated_memory=lambda: 2)
            with patch.dict("sys.modules", torch=types.SimpleNamespace(mps=mps)), patch("training.extract_local.on_ac_power", return_value=True):
                first = extract_local(manifest, folder / "features", loader=loader)
                second = extract_local(manifest, folder / "features", loader=loader)
            self.assertTrue(first["complete"])
            self.assertEqual(first["new_extractions"], 1)
            self.assertEqual(second["new_extractions"], 0)
            loader.assert_called_once()
            _, meta = read_feature(folder / "features", item, spec_hash(spec))
            self.assertEqual(meta["protocol"], MPS_STILL_PROTOCOL)
            # A partial/new run does not start on battery by default.
            with patch("training.extract_local.on_ac_power", return_value=False):
                with self.assertRaisesRegex(RuntimeError, "AC power"):
                    extract_local(manifest, folder / "other-features", loader=loader)


if __name__ == "__main__":
    unittest.main()
