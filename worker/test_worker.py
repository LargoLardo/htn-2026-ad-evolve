"""Offline checks only: synthetic fixture ratings test math, never ship a head."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from calibrate import fit
import tribe_worker as worker


class CalibrationBoundaryTest(unittest.TestCase):
    def test_group_leakage_rejected_and_fitted_head_roundtrips(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            rows = []
            for index, value in enumerate([0, 1, 2, 3, .5, 1.5, 2.5, 3.5]):
                path = folder / f"fixture-{index}.npz"
                np.savez(path, pooled=np.full(20, value))
                path.with_suffix(".json").write_text(json.dumps({"media_hash": str(index),
                    "model_revision": "a" * 40, "code_revision": "b" * 40, "protocol": worker.PROTOCOL}))
                rows.append({"features": str(path), "product_group": f"product-{index // 2}",
                    "split": "train" if index < 4 else "validation",
                    "ratings": {label: 20 + value * 10 for label in worker.LABELS}})
            manifest, output = folder / "labels.json", folder / "head.npz"
            rows[-1]["product_group"] = rows[0]["product_group"]
            manifest.write_text(json.dumps(rows))
            with self.assertRaisesRegex(ValueError, "disjoint products"):
                fit(manifest, output, "test-only")
            rows[-1]["product_group"] = "product-3"
            manifest.write_text(json.dumps(rows))
            with contextlib.redirect_stdout(io.StringIO()):
                fit(manifest, output, "test-only")
            metadata = json.loads(output.with_suffix(".json").read_text())
            self.assertLess(metadata["validation_metrics"]["mae"]["joy"], metadata["validation_metrics"]["constant_baseline_mae"]["joy"])
            with patch.dict(os.environ, {"TRIBE_DECODER_PATH": str(output)}), patch.object(worker, "REVISION", "a" * 40), patch.object(worker, "CODE_REVISION", "b" * 40):
                worker.load_decoder()
                self.assertEqual(worker.DECODER["weights"].shape, (20, 4))
                self.assertEqual(worker.META["version"], "test-only")
                metadata["protocol"] = "different-exposure"
                output.with_suffix(".json").write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, "does not match"):
                    worker.load_decoder()


if __name__ == "__main__":
    unittest.main()
