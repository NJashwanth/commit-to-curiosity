import json

import numpy as np
import pytest
import torch

import dataset as ds
import export as ex
import reference as ref
import train as tr
from model import DigitCNN


@pytest.fixture(scope="module")
def model():
    torch.manual_seed(1)
    m = DigitCNN().eval()
    with torch.no_grad():
        for p in m.parameters():
            p.mul_(2.0)
    return m


def test_json_has_the_architecture_and_compact_float_lists(model, tmp_path):
    out = tmp_path / "model.json"
    size = ex.write_json(ex.export_model(model, {"dataset": "mnist"}), out)
    spec = json.loads(out.read_text())
    assert size == out.stat().st_size
    assert spec["format"] == "digit-sketch-cnn" and spec["version"] == 1
    assert spec["meta"] == {"params": 56_714, "dataset": "mnist"}
    assert spec["input"] == {"shape": [1, 28, 28], "mean": 0.1307, "std": 0.3081}
    assert [l["type"] for l in spec["layers"]] == [
        "conv2d", "relu", "maxpool", "conv2d", "relu", "maxpool", "flatten", "dense", "relu", "dense", "softmax"]
    conv1, conv2, fc1, fc2 = (l for l in spec["layers"] if l["type"] in ("conv2d", "dense"))
    assert (len(conv1["weight"]), len(conv1["bias"])) == (16 * 1 * 9, 16)
    assert (len(conv2["weight"]), len(conv2["bias"])) == (32 * 16 * 9, 32)
    assert (len(fc1["weight"]), len(fc1["bias"])) == (64 * 800, 64)
    assert (len(fc2["weight"]), len(fc2["bias"])) == (10 * 64, 10)
    assert "\n" not in out.read_text() and ", " not in out.read_text()  # compact separators
    assert size < ex.MAX_BYTES


def test_floats_are_rounded_to_seven_significant_digits(model):
    spec = ex.export_model(model)
    exact = model.fc1.weight.detach().numpy().ravel()
    rounded = np.array(next(l for l in spec["layers"] if l["type"] == "dense")["weight"])
    assert not np.array_equal(rounded, exact)
    assert np.all(np.abs(rounded - exact) <= np.abs(exact) * 5.1e-7 + 1e-30)
    assert all(len(f"{v:.7g}".replace("-", "").replace(".", "").lstrip("0")) <= 13 for v in rounded[:50])


def test_round_trip_through_a_file_preserves_the_weights(model, tmp_path):
    out = tmp_path / "m.json"
    ex.write_json(ex.export_model(model), out)
    loaded = ref.load_model(out)
    convs = [l for l in loaded["layers"] if l["type"] == "conv2d"]
    assert np.allclose(convs[0]["weight"], model.conv1.weight.detach().numpy(), rtol=1e-5, atol=1e-9)
    assert np.allclose(convs[1]["weight"], model.conv2.weight.detach().numpy(), rtol=1e-5, atol=1e-9)
    dense = [l for l in loaded["layers"] if l["type"] == "dense"]
    assert dense[0]["weight"].shape == (64, 800) and dense[1]["weight"].shape == (10, 64)
    assert np.allclose(dense[1]["bias"], model.fc2.bias.detach().numpy(), rtol=1e-5, atol=1e-9)


def test_rounded_export_still_matches_pytorch_within_1e_5(model, tmp_path):
    out = tmp_path / "m.json"
    ex.write_json(ex.export_model(model), out)
    x = np.random.default_rng(5).random((60, 28, 28)).astype(np.float32)
    result = ex.compare(model, out, x)
    assert result["max_abs_diff"] < ex.TOLERANCE
    assert result["predictions_match"] and result["images"] == 60


def test_end_to_end_checkpoint_to_verified_json(tmp_path):
    run_dir = tmp_path / "run"
    tr.main(["--source", "synthetic", "--epochs", "1", "--synthetic-train", "300", "--synthetic-test", "100",
             "--out-dir", str(run_dir), "--data-dir", str(tmp_path)])
    out = tmp_path / "web" / "model.json"
    messages = []
    result = ex.run(run_dir / "model.pt", out, str(tmp_path), verify_images=50, log=messages.append)
    assert out.exists() and result["bytes"] == out.stat().st_size
    assert result["max_abs_diff"] < ex.TOLERANCE and result["predictions_match"]
    assert json.loads(out.read_text())["meta"]["dataset"] == ds.SOURCE_SYNTHETIC
    assert any("verified on 50 test images" in m for m in messages)


def test_cli_entry_point(tmp_path, capsys):
    run_dir = tmp_path / "run"
    tr.main(["--source", "synthetic", "--epochs", "1", "--synthetic-train", "200", "--synthetic-test", "60",
             "--out-dir", str(run_dir), "--data-dir", str(tmp_path)])
    ex.main(["--ckpt", str(run_dir / "model.pt"), "--out", str(tmp_path / "m.json"), "--data-dir", str(tmp_path),
             "--verify-images", "20",
             "--fixtures-dir", str(tmp_path / "fx")])
    assert "verified on 20 test images" in capsys.readouterr().out
    assert (tmp_path / "fx" / "ops.json").exists() and (tmp_path / "fx" / "forward.json").exists()
    ex.main(["--ckpt", str(run_dir / "model.pt"), "--out", str(tmp_path / "m2.json"), "--data-dir", str(tmp_path),
             "--verify-images", "10", "--no-fixtures"])
    assert "parity fixtures" not in capsys.readouterr().out


def test_a_failed_verification_raises(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    tr.main(["--source", "synthetic", "--epochs", "1", "--synthetic-train", "200", "--synthetic-test", "60",
             "--out-dir", str(run_dir), "--data-dir", str(tmp_path)])
    monkeypatch.setattr(ex, "compare", lambda *a, **k: {"max_abs_diff": 0.5, "predictions_match": False, "images": 1})
    with pytest.raises(SystemExit, match="verification failed"):
        ex.run(run_dir / "model.pt", tmp_path / "m.json", str(tmp_path), 10, log=lambda *_: None)


def test_oversize_files_are_flagged(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    tr.main(["--source", "synthetic", "--epochs", "1", "--synthetic-train", "200", "--synthetic-test", "60",
             "--out-dir", str(run_dir), "--data-dir", str(tmp_path)])
    monkeypatch.setattr(ex, "MAX_BYTES", 1000)
    messages = []
    ex.run(run_dir / "model.pt", tmp_path / "m.json", str(tmp_path), 10, log=messages.append)
    assert any("over the 1,000 byte budget" in m for m in messages)
