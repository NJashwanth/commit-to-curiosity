import json

import numpy as np
import pytest
import torch

import fixtures as fx
from model import DigitCNN


def test_op_fixtures_are_deterministic_and_cover_every_operation():
    a, b = fx.make_op_fixtures(0), fx.make_op_fixtures(0)
    assert a == b
    assert a != fx.make_op_fixtures(1)
    assert set(a) == {"conv2d", "relu", "maxpool", "flatten", "dense", "softmax"}
    assert all(len(cases) >= 3 for cases in a.values())


def test_op_fixture_shapes_and_values_are_consistent():
    ops = fx.make_op_fixtures()
    for case in ops["conv2d"]:
        c, h, w = case["input"]["shape"]
        k, o = case["kernel"], case["out"]
        assert case["expected"]["shape"] == [o, h - k + 1, w - k + 1]
        assert case["weight"]["shape"] == [o, c, k, k]
    for case in ops["maxpool"]:
        c, h, w = case["input"]["shape"]
        assert case["expected"]["shape"] == [c, h // case["size"], w // case["size"]]
    for case in ops["softmax"]:
        assert sum(case["expected"]["data"]) == pytest.approx(1.0, abs=1e-6)
    for case in ops["relu"]:
        assert min(case["expected"]["data"]) >= 0.0
    for case in ops["flatten"]:
        assert case["expected"]["shape"] == [int(np.prod(case["input"]["shape"]))]


def test_pick_per_digit_takes_the_first_two_of_each_digit():
    y = np.array([3, 1, 0, 0, 1, 2, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 8, 7, 6, 5, 4, 3, 2])
    picks = fx.pick_per_digit(y, 2)
    assert [int(y[i]) for i in picks] == [d for d in range(10) for _ in range(2)]
    assert picks[:2] == [2, 3]


def test_forward_fixtures_hold_quantised_images_and_torch_probabilities(tmp_path):
    torch.manual_seed(0)
    model = DigitCNN().eval()
    rng = np.random.default_rng(0)
    x = rng.random((100, 28, 28)).astype(np.float32)
    y = np.arange(100) % 10
    path = tmp_path / "model.json"
    path.write_text("{}")
    out = fx.make_forward_fixtures(model, x, y, path)
    assert len(out["images"]) == 20 and len(out["images"][0]) == 784
    assert out["labels"] == [d for d in range(10) for _ in range(2)]
    assert all(0 <= v <= 255 and isinstance(v, int) for v in out["images"][0])
    assert np.allclose(np.sum(out["probs"], axis=1), 1.0, atol=1e-5)
    assert out["predictions"] == [int(np.argmax(p)) for p in out["probs"]]
    assert out["model_fingerprint"] == fx.fingerprint(path)
    path.write_text("{ }")
    assert fx.fingerprint(path) != out["model_fingerprint"]


def test_preprocess_fixtures_cover_the_awkward_cases():
    fixture = fx.make_preprocess_fixtures()
    cases = fixture["cases"]
    assert fixture == fx.make_preprocess_fixtures()  # deterministic
    assert len(cases) >= 6
    for c in cases:
        assert len(c["pixels"]) == c["width"] * c["height"]
        assert len(c["expected"]) == 784
        assert max(c["pixels"]) <= 255 and max(c["expected"]) <= 1.0
    assert [c["empty"] for c in cases].count(True) == 1
    empty = next(c for c in cases if c["empty"])
    assert max(empty["expected"]) == 0.0
    assert len({(c["width"], c["height"]) for c in cases}) >= 4  # different canvas sizes and aspect ratios
    nonempty = [c for c in cases if not c["empty"]]
    assert all(max(c["expected"]) == pytest.approx(1.0) for c in nonempty)


def test_write_fixtures_and_the_cli(tmp_path, capsys):
    import train as tr
    tr.main(["--source", "synthetic", "--epochs", "1", "--synthetic-train", "300", "--synthetic-test", "100",
             "--out-dir", str(tmp_path / "run"), "--data-dir", str(tmp_path)])
    (tmp_path / "model.json").write_text("{}")
    fx.main(["--ckpt", str(tmp_path / "run" / "model.pt"), "--model-json", str(tmp_path / "model.json"),
             "--out", str(tmp_path / "fixtures"), "--data-dir", str(tmp_path)])
    assert "21 ops" not in capsys.readouterr().out
    assert json.loads((tmp_path / "fixtures" / "forward.json").read_text())["mean"] == 0.1307
    assert (tmp_path / "fixtures" / "ops.json").stat().st_size > 1000
    assert len(json.loads((tmp_path / "fixtures" / "preprocess.json").read_text())["cases"]) >= 6
