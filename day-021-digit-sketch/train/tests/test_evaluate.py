import numpy as np
import torch

import evaluate as ev
from model import DigitCNN


def test_confusion_matrix_counts_true_rows_against_predicted_columns():
    y_true = np.array([0, 0, 1, 2, 2, 2])
    y_pred = np.array([0, 1, 1, 2, 2, 0])
    cm = ev.confusion_matrix(y_true, y_pred, classes=3)
    assert cm.tolist() == [[1, 1, 0], [0, 1, 0], [1, 0, 2]]
    assert cm.sum() == 6 and np.trace(cm) == 4
    assert ev.accuracy(y_true, y_pred) == 4 / 6


def test_misclassified_orders_by_confidence_in_the_wrong_answer():
    probs = np.array([[0.9, 0.1], [0.4, 0.6], [0.05, 0.95], [0.3, 0.7]])
    y_true = np.array([0, 0, 0, 1])   # rows 1 and 2 are wrong; row 3 is right
    assert ev.misclassified(y_true, probs).tolist() == [2, 1]


def test_format_confusion_lays_out_ten_rows():
    text = ev.format_confusion(np.eye(10, dtype=int) * 100)
    lines = text.splitlines()
    assert len(lines) == 11 and lines[0].startswith("true\\pred")
    assert lines[1].split()[:2] == ["0", "100"]


def test_predict_probs_returns_normalised_probabilities_in_batches():
    torch.manual_seed(0)
    x = np.random.default_rng(0).random((50, 28, 28)).astype(np.float32)
    model = DigitCNN()
    probs = ev.predict_probs(model, x, batch_size=16)
    assert probs.shape == (50, 10)
    assert np.allclose(probs.sum(axis=1), 1.0, atol=1e-5)
    assert np.allclose(probs, ev.predict_probs(model, x, batch_size=50), atol=1e-6)
    assert ev.predict_probs(model, x[:0]).shape == (0, 10)


def test_plots_are_written(tmp_path):
    rng = np.random.default_rng(0)
    x = rng.random((20, 28, 28)).astype(np.float32)
    y = rng.integers(0, 10, 20)
    probs = rng.dirichlet(np.ones(10), 20)
    cm = ev.confusion_matrix(y, probs.argmax(1))
    ev.plot_confusion_matrix(cm, tmp_path / "cm.png")
    drawn = ev.plot_misclassified(x, y, probs, tmp_path / "bad.png", max_items=5)
    ev.plot_history([{"epoch": 1, "train_acc": 0.5, "val_acc": 0.6}, {"epoch": 2, "train_acc": 0.7, "val_acc": 0.8}], tmp_path / "h.png")
    assert drawn == 5
    for name in ("cm.png", "bad.png", "h.png"):
        assert (tmp_path / name).stat().st_size > 1000


def test_misclassified_plot_survives_a_perfect_model(tmp_path):
    x = np.zeros((3, 28, 28), dtype=np.float32)
    probs = np.eye(10)[[0, 1, 2]]
    assert ev.plot_misclassified(x, np.array([0, 1, 2]), probs, tmp_path / "none.png") == 0
    assert (tmp_path / "none.png").exists()
