import json

import numpy as np
import pytest
import torch

import augment as aug
import dataset as ds
import evaluate as ev
import train as tr
from model import DigitCNN


@pytest.fixture(scope="module")
def tiny(font_paths_module):
    return ds.load_dataset("synthetic", seed=0, n_synthetic=(700, 200), font_paths=font_paths_module)


@pytest.fixture(scope="module")
def font_paths_module():
    import synthetic
    return synthetic.find_fonts()[:8]


def test_a_tiny_training_run_improves_accuracy(tiny):
    torch.manual_seed(0)
    before = ev.accuracy(tiny.y_val, ev.predict_probs(DigitCNN(), tiny.x_val).argmax(1))
    model, history, best = tr.train(tiny, epochs=4, seed=0, log=lambda *_: None)
    after = ev.accuracy(tiny.y_val, ev.predict_probs(model, tiny.x_val).argmax(1))
    assert after > before + 0.25
    assert after > 0.4
    assert history[-1]["train_loss"] < history[0]["train_loss"]
    assert len(history) == 4 and best["val_acc"] == max(h["val_acc"] for h in history)
    assert after == pytest.approx(best["val_acc"])  # the returned model holds the best epoch's weights


def test_training_is_deterministic_for_a_seed(tiny):
    a = tr.train(tiny, epochs=1, seed=3, log=lambda *_: None)[0]
    b = tr.train(tiny, epochs=1, seed=3, log=lambda *_: None)[0]
    for pa, pb in zip(a.parameters(), b.parameters()):
        assert torch.equal(pa, pb)


def test_training_with_augmentation_runs(tiny):
    small = ds.DigitData(tiny.x_train[:64], tiny.y_train[:64], tiny.x_val, tiny.y_val, tiny.x_test, tiny.y_test, tiny.source)
    _, history, _ = tr.train(small, epochs=1, augmentation=aug.LIGHT, log=lambda *_: None)
    assert len(history) == 1


def test_pick_augmentation():
    assert tr.pick_augmentation("auto", ds.SOURCE_MNIST) is aug.LIGHT
    assert tr.pick_augmentation("auto", ds.SOURCE_SYNTHETIC) is None
    assert tr.pick_augmentation("heavy", ds.SOURCE_MNIST) is aug.HEAVY
    assert tr.pick_augmentation("none", ds.SOURCE_MNIST) is None


def test_main_writes_the_checkpoint_metrics_and_plots(tmp_path, capsys):
    out = tmp_path / "run"
    tr.main(["--source", "synthetic", "--epochs", "2", "--synthetic-train", "400", "--synthetic-test", "100",
             "--limit-train", "300", "--out-dir", str(out), "--data-dir", str(tmp_path / "data")])
    for name in ("model.pt", "metrics.json", "training_curve.png", "confusion_matrix.png", "misclassified.png"):
        assert (out / name).exists(), name
    metrics = json.loads((out / "metrics.json").read_text())
    assert metrics["dataset"]["source"] == "synthetic-fonts"
    assert metrics["model"]["params"] == 56_714
    assert len(metrics["history"]) == 2
    assert np.array(metrics["val_confusion_matrix"]).sum() == 40
    assert np.array(metrics["test_confusion_matrix"]).sum() == 100
    ckpt = torch.load(out / "model.pt")
    assert set(ckpt) == {"state_dict", "config", "metrics"}
    printed = capsys.readouterr().out
    assert "validation accuracy" in printed and "dataset source: synthetic-fonts" in printed
