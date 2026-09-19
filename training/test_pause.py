"""Verify archived entry points stop before network, GPU loading or training."""
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from training.local_mps import download_snapshots, load_mps
from training.pause import require_experimental_resume


class PauseTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_model_loader_and_downloader_refuse_by_default(self):
        for call in [require_experimental_resume, lambda: download_snapshots("unused"), load_mps]:
            with self.assertRaisesRegex(RuntimeError, "paused"):
                call()

    def test_clis_require_opt_in_and_automatic_training_is_disabled(self):
        env = {key: value for key, value in os.environ.items() if key != "EVOLVE_ENABLE_EXPERIMENTAL_TRAINING"}
        for module in ["training.train_decoder", "training.extract_local", "training.extract_features"]:
            result = subprocess.run([sys.executable, "-m", module], capture_output=True, text=True, env=env, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("paused", result.stderr)
        result = subprocess.run([sys.executable, "-m", "training.extract_local", "--train-when-complete"],
            capture_output=True, text=True, env={**env, "EVOLVE_ENABLE_EXPERIMENTAL_TRAINING": "1"}, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Automatic decoder training is disabled", result.stderr)


if __name__ == "__main__":
    unittest.main()
