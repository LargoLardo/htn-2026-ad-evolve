"""Synthetic numerical/transport tests. No TRIBE inference or deploys occur here."""
import base64
import contextlib
import errno
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import zipfile

import numpy as np
from PIL import Image

from training.extract_features import extract, read_feature, save_result, validate_endpoint
from training.score_image import score_image
from training.baseten_auth import authorization_headers
from training.package_decoder import package
from training.make_pilot import make_pilot
from training.prepare_oasis import assign_splits
from training.train_decoder import load_dataset, train
from worker import affect_decoder
from worker import clip_cache
from worker import tribe_worker as protocol_worker
from worker.affect_decoder import AffectDecoder, LABELS, normalize_image, spec_hash


def result_for(item, values):
    raw = np.asarray(values, dtype="<f4").tobytes()
    return {"id": item["id"], "media_hash": item["media_hash"], "feature_dim": len(values),
        "pooled_f32_base64": base64.b64encode(raw).decode(), "pooled_sha256": hashlib.sha256(raw).hexdigest(),
        "metadata": {"feature_spec_hash": spec_hash(), "cached": False}}


def fixture(folder):
    rng = np.random.default_rng(42)
    features = folder / "features"
    features.mkdir()
    rows = []
    for i in range(32):
        vector = rng.normal(size=5)
        scores = np.clip([50 + 8 * vector[0] - 4 * vector[1], 50 + 9 * vector[2]], 0, 100)
        row = {"id": f"I{i}", "media_hash": f"media-{i}", "source_sha256": f"source-{i}",
            "group": f"group-{i // 2}", "split": "train" if i < 16 else "validation" if i < 24 else "test",
            "ratings": dict(zip(LABELS, scores))}
        rows.append(row)
        save_result(features, row, result_for(row, vector), spec_hash())
    manifest = folder / "manifest.json"
    manifest.write_text(json.dumps({"dataset": "synthetic-test-only", "labels": LABELS,
        "feature_spec_hash": spec_hash(), "rating_scale": [0, 100], "items": rows}))
    return manifest, features, rows


class TrainingTests(unittest.TestCase):
    def test_wide_decoder_stays_finite_and_matches_scalar_prediction(self):
        rng = np.random.default_rng(17)
        x, y = rng.normal(size=(40, 20484)), rng.uniform(0, 100, size=(40, 2))
        with np.errstate(all="raise"):
            head = affect_decoder.fit_ridge(x, y, 10000)
            batch = affect_decoder.predict(head, x[:3])
            single = np.stack([affect_decoder.predict(head, row) for row in x[:3]])
        self.assertTrue(np.isfinite(batch).all())
        np.testing.assert_allclose(batch, single)

    def test_endpoint_does_not_send_credentials_to_untrusted_urls(self):
        validate_endpoint("https://model-test.api.baseten.co/development/predict")
        for url in ["http://model-test.api.baseten.co/predict", "https://api.baseten.co.attacker.test/predict",
                    "https://a.api.baseten.co/predict?redirect=bad", "https://user@a.api.baseten.co/predict",
                    "https://a.api.baseten.co:8443/predict", "https://a.api.baseten.co/predict#bad"]:
            with self.assertRaises(ValueError):
                validate_endpoint(url)

    def test_score_client_checks_media_version_and_scores_without_retries(self):
        buffer = io.BytesIO()
        Image.new("RGB", (20, 10), (20, 30, 40)).save(buffer, format="PNG")
        raw = buffer.getvalue()
        media_hash = hashlib.sha256(normalize_image(raw)).hexdigest()
        result = {"id": "image-" + media_hash[:16], "media_hash": media_hash,
            "metadata": {"feature_spec_hash": spec_hash()}, "affect": {"valence": 60, "arousal": 30}}
        body = {"feature_spec_hash": spec_hash(), "decoder_version": "fixture-v1", "results": [result]}
        response = types.SimpleNamespace(status_code=200, json=lambda: body)
        with patch("training.score_image.requests.post", return_value=response) as post:
            auth = Mock(return_value={"Authorization": "Bearer test-only"})
            def invoke():
                return score_image(raw, "https://a.api.baseten.co/development/predict", "fixture-v1", auth_headers=auth)
            self.assertEqual(invoke()["results"][0]["affect"], result["affect"])
            self.assertFalse(post.call_args.kwargs["allow_redirects"])
            body["decoder_version"] = "wrong"
            with self.assertRaisesRegex(ValueError, "version"):
                invoke()
            body["decoder_version"] = "fixture-v1"
            result["media_hash"] = "wrong"
            with self.assertRaisesRegex(ValueError, "stimulus"):
                invoke()
            result["media_hash"] = media_hash
            result["affect"]["valence"] = float("nan")
            with self.assertRaisesRegex(ValueError, "invalid"):
                invoke()
            response.status_code = 503
            before = post.call_count
            with self.assertRaisesRegex(RuntimeError, "No automatic retry"):
                invoke()
            self.assertEqual(post.call_count, before + 1)
            self.assertEqual(auth.call_count, post.call_count)

    def test_ten_second_protocol_is_explicit_and_legacy_is_preserved(self):
        self.assertEqual(protocol_worker.protocol_options(protocol_worker.SHORT_LOSSLESS_PROTOCOL), (10, True))
        self.assertEqual(protocol_worker.protocol_options(protocol_worker.LOSSLESS_PROTOCOL), (30, True))
        self.assertEqual(protocol_worker.protocol_options(protocol_worker.PROTOCOL), (30, False))
        with self.assertRaisesRegex(ValueError, "Unknown"):
            protocol_worker.protocol_options("unversioned")

    def test_budget_pilot_is_label_blind_and_preserves_disjoint_groups(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            folder = Path(tmp)
            manifest, _, _ = fixture(folder)
            data = json.loads(manifest.read_text())
            data["archive"] = "fixture.zip"
            manifest.write_text(json.dumps(data))
            counts = {"train": 4, "validation": 3, "test": 3}
            first = make_pilot(manifest, folder / "pilot-a.json", counts)
            for row in data["items"]:
                row["ratings"] = {label: 0 for label in LABELS}
            manifest.write_text(json.dumps(data))
            second = make_pilot(manifest, folder / "pilot-b.json", counts)
            self.assertEqual([r["id"] for r in first["items"]], [r["id"] for r in second["items"]])
            self.assertEqual(len({r["group"] for r in first["items"]}), 10)
            originals = {r["id"]: r["split"] for r in data["items"]}
            self.assertTrue(all(originals[r["id"]] == r["split"] for r in first["items"]))
            with self.assertRaisesRegex(ValueError, "frozen"):
                make_pilot(manifest, folder / "pilot-a.json", counts)

    def test_auth_supports_api_key_and_refreshable_truss_login(self):
        self.assertEqual(authorization_headers("test-only")(), {"Authorization": "Bearer test-only"})
        with self.assertRaisesRegex(ValueError, "truss-remote"):
            authorization_headers()
        remote = types.SimpleNamespace(fetch_auth_header=Mock(side_effect=[
            {"Authorization": "Bearer fixture-first"}, {"Authorization": "Bearer fixture-refreshed"}]))
        factory = types.SimpleNamespace(create=Mock(return_value=remote))
        with patch.dict(sys.modules, {"truss.remote.remote_factory": types.SimpleNamespace(RemoteFactory=factory)}):
            headers = authorization_headers(truss_remote="baseten")
            self.assertEqual(headers()["Authorization"], "Bearer fixture-first")
            self.assertEqual(headers()["Authorization"], "Bearer fixture-refreshed")
        factory.create.assert_called_once_with("baseten")

    def test_image_preserves_aspect_and_is_idempotent(self):
        buffer = io.BytesIO()
        Image.new("RGB", (100, 50), (255, 0, 0)).save(buffer, format="PNG")
        png = normalize_image(buffer.getvalue())
        image = Image.open(io.BytesIO(png))
        self.assertEqual(image.size, (1024, 1024))
        self.assertEqual(image.getpixel((512, 0)), (127, 127, 127))
        self.assertEqual(image.getpixel((512, 512)), (255, 0, 0))
        self.assertEqual(normalize_image(png), png)

    def test_related_and_duplicate_images_stay_together(self):
        rng = np.random.default_rng(10)
        rows = [{"id": f"I{i}", "theme_group": f"theme-{i // 2}", "media_hash": str(i),
            "perceptual_hash": f"{int(rng.integers(0, 2**63)):016x}"} for i in range(40)]
        rows[4]["media_hash"] = rows[0]["media_hash"]
        rows[8]["perceptual_hash"] = rows[0]["perceptual_hash"]
        assign_splits(rows, 42)
        self.assertEqual(len({rows[i]["group"] for i in [0, 1, 4, 5, 8, 9]}), 1)
        self.assertEqual(len({rows[i]["split"] for i in [0, 1, 4, 5, 8, 9]}), 1)
        self.assertEqual({row["split"] for row in rows}, {"train", "validation", "test"})

    def test_fit_package_and_reload(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            folder = Path(tmp)
            manifest, features, rows = fixture(folder)
            output = folder / "head.npz"
            metadata = train(manifest, features, output, "synthetic-test-only", alphas=(.01, 10, 1000))
            self.assertTrue(all(metadata["test_beats_constant_baseline"].values()))
            model = AffectDecoder(output)
            x, _ = read_feature(features, rows[0], spec_hash())
            self.assertEqual(set(model.score(x)), set(LABELS))
            train_x = np.stack([read_feature(features, row, spec_hash())[0] for row in rows[:16]])
            np.testing.assert_allclose(model.head["mean"], train_x.astype(float).mean(axis=0))
            package(output, folder / "bundle")
            self.assertEqual(AffectDecoder(folder / "bundle/decoder.npz").metadata["version"], "synthetic-test-only")
            with self.assertRaisesRegex(ValueError, "versioned"):
                train(manifest, features, output, "replacement")
            changed = dict(model.metadata)
            changed["labels"] = ["joy", "trust"]
            output.with_suffix(".json").write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, "schema"):
                AffectDecoder(output)

    def test_test_labels_do_not_change_training_or_model_selection(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            folder = Path(tmp)
            manifest, features, _ = fixture(folder)
            first = train(manifest, features, folder / "a.npz", "fixture-a")
            data = json.loads(manifest.read_text())
            for row in data["items"]:
                if row["split"] == "test":
                    row["ratings"] = {label: 0 for label in LABELS}
            manifest.write_text(json.dumps(data))
            second = train(manifest, features, folder / "b.npz", "fixture-b")
            self.assertEqual(first["selected_alpha"], second["selected_alpha"])
            a, b = AffectDecoder(folder / "a.npz"), AffectDecoder(folder / "b.npz")
            for key in a.head:
                np.testing.assert_array_equal(a.head[key], b.head[key])

    def test_leakage_and_corrupt_features_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            manifest, features, rows = fixture(folder)
            data = json.loads(manifest.read_text())
            data["items"][-1]["group"] = rows[0]["group"]
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "leakage"):
                load_dataset(manifest, features)
            data["items"][-1]["group"] = rows[-1]["group"]
            data["items"][-1]["media_hash"] = rows[0]["media_hash"]
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "leakage"):
                load_dataset(manifest, features)
            (features / "I0.npz").write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "corrupt"):
                read_feature(features, rows[0], spec_hash())

    def test_transport_rejects_wrong_media_spec_nan_and_checksum(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = {"id": "I1", "media_hash": "expected"}
            result = result_for(item, [1, 2])
            result["media_hash"] = "wrong"
            with self.assertRaisesRegex(ValueError, "different stimulus"):
                save_result(Path(tmp), item, result, spec_hash())
            result = result_for(item, [float("nan"), 2])
            with self.assertRaisesRegex(ValueError, "Nonfinite"):
                save_result(Path(tmp), item, result, spec_hash())
            result = result_for(item, [1, 2])
            result["pooled_sha256"] = "wrong"
            with self.assertRaisesRegex(ValueError, "checksum"):
                save_result(Path(tmp), item, result, spec_hash())

    def test_remote_extraction_resumes_without_repeating_requests(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            folder = Path(tmp)
            png_buffer = io.BytesIO()
            Image.new("RGB", (1024, 1024), (255, 0, 0)).save(png_buffer, format="PNG")
            png = normalize_image(png_buffer.getvalue())
            item = {"id": "I1", "image_member": "image.png", "media_hash": hashlib.sha256(png).hexdigest()}
            archive = folder / "images.zip"
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("image.png", png)
            manifest = folder / "manifest.json"
            manifest.write_text(json.dumps({"archive": "images.zip", "items": [item],
                "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "feature_spec_hash": spec_hash()}))
            response = types.SimpleNamespace(status_code=200, json=lambda: {
                "feature_spec_hash": spec_hash(), "results": [result_for(item, [1, 2, 3])]})
            with patch("training.extract_features.requests.Session") as session:
                session.return_value.__enter__.return_value.post.return_value = response
                endpoint = "https://model-test.api.baseten.co/development/predict"
                auth = Mock(return_value={"Authorization": "Bearer test-only"})
                self.assertEqual(extract(manifest, folder / "features", endpoint, auth_headers=auth)["network_calls"], 1)
                self.assertEqual(extract(manifest, folder / "features", endpoint, auth_headers=auth)["network_calls"], 0)
                auth.assert_called_once_with()
                self.assertEqual(session.return_value.__enter__.return_value.post.call_count, 1)
                self.assertEqual(session.return_value.__enter__.return_value.post.call_args.kwargs["headers"],
                    {"Authorization": "Bearer test-only"})
            with self.assertRaisesRegex(ValueError, "HTTPS"):
                extract(manifest, folder / "features", "https://untrusted.example/predict", "test-only")


class BasetenContractTests(unittest.TestCase):
    def model_module(self):
        path = Path(__file__).resolve().parents[1] / "deploy/baseten/model/model.py"
        spec = importlib.util.spec_from_file_location("baseten_test_model", path)
        module = importlib.util.module_from_spec(spec)
        worker = types.SimpleNamespace(MODEL=object(), extract=lambda candidate: (
            np.array([1, 2, 3]), candidate["media_hash"], None, {"cached": False}))
        with patch.dict(sys.modules, affect_decoder=affect_decoder, tribe_worker=worker, clip_cache=clip_cache):
            spec.loader.exec_module(module)
        return module

    def model_class(self):
        return self.model_module().Model

    def test_missing_shared_cache_falls_back_without_hiding_disk_errors(self):
        module = self.model_module()
        with patch.object(Path, "mkdir", side_effect=[PermissionError(errno.EACCES, "denied"), None]), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.writable_cache("/cache/unavailable", "/tmp/fallback"), Path("/tmp/fallback"))
        with patch.object(Path, "mkdir", side_effect=OSError(errno.ENOSPC, "disk full")):
            with self.assertRaises(OSError):
                module.writable_cache("/cache/unavailable", "/tmp/fallback")

    def test_snapshot_allowlist_requires_pinned_local_weights(self):
        module = self.model_module()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture-revision"
            path.mkdir()
            registry = []
            with self.assertRaisesRegex(ValueError, "snapshot"):
                module.register_snapshot(str(path), path.name, registry)
            (path / "config.json").write_text("{}")
            (path / "model.safetensors").write_bytes(b"test-only")
            module.register_snapshot(str(path), path.name, registry)
            module.register_snapshot(str(path), path.name, registry)
            self.assertEqual(registry, [str(path)])
            with self.assertRaisesRegex(ValueError, "snapshot"):
                module.register_snapshot(str(path), "wrong-revision", registry)

    def test_clip_cache_reuses_only_identical_eval_inputs(self):
        calls = []
        class Video:
            MODELS = ("vjepa2",)
            def __init__(self, model_name, *args):
                self.model_name = model_name
                self.model = types.SimpleNamespace(training=False)
            def predict_hidden_states(self, images, audio=None):
                calls.append(1)
                return images.sum()
        module = types.SimpleNamespace(_HFVideoModel=Video)
        stats = {"hits": 0, "misses": 0}
        clip_cache.install_exact_clip_cache(module, "pinned-vjepa2", stats)
        model = module._HFVideoModel("pinned-vjepa2")
        pixels = np.ones((2, 3, 3, 3), dtype=np.uint8)
        self.assertEqual(model.predict_hidden_states(pixels), model.predict_hidden_states(pixels.copy()))
        self.assertEqual(len(calls), 1)
        self.assertEqual(stats, {"hits": 1, "misses": 1})
        pixels[0, 0, 0, 0] = 2
        model.predict_hidden_states(pixels)
        self.assertEqual(len(calls), 2)
        self.assertIs(module._HFVideoModel("pinned-vjepa2"), model)
        model.model.training = True
        model.predict_hidden_states(pixels)
        self.assertEqual(len(calls), 3)
        other = module._HFVideoModel("different-model")
        other.predict_hidden_states(pixels)
        other.predict_hidden_states(pixels)
        self.assertEqual(len(calls), 5)

    def test_clip_cache_checks_real_repeated_forward_before_reuse(self):
        class Video:
            MODELS = ("vjepa2",)
            def __init__(self, model_name, *args):
                self.model_name = model_name
                self.model = types.SimpleNamespace(training=False)
                self.calls = 0
                self.unstable = False
            def predict_hidden_states(self, images, audio=None):
                self.calls += 1
                return images.sum() + (self.calls if self.unstable else 0)
        module = types.SimpleNamespace(_HFVideoModel=Video)
        stats = {"hits": 0, "misses": 0}
        clip_cache.install_exact_clip_cache(module, "pinned-vjepa2", stats, verify_equal=np.array_equal)
        model = module._HFVideoModel("pinned-vjepa2")
        pixels = np.ones((2, 3), dtype=np.uint8)
        for _ in range(3):
            model.predict_hidden_states(pixels)
        self.assertEqual(model.calls, 2)
        self.assertEqual(stats["verification_forwards"], 1)
        pixels[0, 0] = 2
        model.unstable = True
        model.predict_hidden_states(pixels)
        with self.assertRaisesRegex(RuntimeError, "different features"):
            model.predict_hidden_states(pixels)

    def test_features_are_portable_and_score_requires_a_head(self):
        model = self.model_class()()
        item = {"id": "I1", "media_hash": "expected"}
        result = model.predict({"action": "features", "candidates": [item]})
        with tempfile.TemporaryDirectory() as tmp:
            save_result(Path(tmp), item, result["results"][0], spec_hash())
            np.testing.assert_array_equal(read_feature(Path(tmp), item, spec_hash())[0], [1, 2, 3])
        with self.assertRaisesRegex(ValueError, "No affect decoder"):
            model.predict({"action": "score", "candidates": [item]})
        with self.assertRaisesRegex(ValueError, "unique"):
            model.predict({"candidates": [item, item]})

    def test_scoring_uses_explicit_valence_arousal_contract(self):
        model = self.model_class()()
        model.decoder = types.SimpleNamespace(metadata={"version": "test-v1"},
            score=lambda pooled: {"valence": 60, "arousal": 35})
        result = model.predict({"action": "score", "decoder_version": "test-v1",
            "candidates": [{"id": "I1", "media_hash": "expected"}]})
        self.assertEqual(result["results"][0]["affect"], {"valence": 60, "arousal": 35})
        self.assertNotIn("emotions", result["results"][0])
        with self.assertRaisesRegex(ValueError, "version mismatch"):
            model.predict({"action": "score", "decoder_version": "wrong"})


if __name__ == "__main__":
    unittest.main()
