"""Evaluation helpers and plots: accuracy, confusion matrix, misclassified digits, training curves."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

from dataset import normalize  # noqa: E402

INK = "#1f2933"        # text and axes
MUTED = "#6b7785"      # recessive: grid, secondary text
BLUE = "#2a6fb0"       # one hue for magnitude (confusion matrix) and for the single series
ORANGE = "#c8651b"     # second series (training accuracy)


def predict_probs(model: torch.nn.Module, x01: np.ndarray, batch_size: int = 1024) -> np.ndarray:
    """Softmax probabilities (N, 10) for images in [0, 1] of shape (N, 28, 28)."""
    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(x01), batch_size):
            xb = torch.from_numpy(normalize(x01[i : i + batch_size])).unsqueeze(1)
            out.append(torch.softmax(model(xb), dim=1).numpy())
    return np.concatenate(out) if out else np.zeros((0, 10), dtype=np.float32)


def accuracy(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float((np.asarray(y_true) == np.asarray(y_pred)).mean())


def confusion_matrix(y_true: np.ndarray, y_pred: np.ndarray, classes: int = 10) -> np.ndarray:
    """cm[i, j] = number of samples with true label i predicted as j."""
    cm = np.zeros((classes, classes), dtype=np.int64)
    np.add.at(cm, (np.asarray(y_true), np.asarray(y_pred)), 1)
    return cm


def misclassified(y_true: np.ndarray, probs: np.ndarray) -> np.ndarray:
    """Indices of wrong predictions, most confidently wrong first."""
    pred = probs.argmax(axis=1)
    wrong = np.nonzero(pred != y_true)[0]
    return wrong[np.argsort(-probs[wrong, pred[wrong]], kind="stable")]


def format_confusion(cm: np.ndarray) -> str:
    """The matrix as text, rows = true digit, columns = predicted digit."""
    width = max(5, len(str(cm.max())) + 2)
    head = "true\\pred" + "".join(f"{j:>{width}}" for j in range(cm.shape[1]))
    rows = [f"{i:>9}" + "".join(f"{v:>{width}}" for v in row) for i, row in enumerate(cm)]
    return "\n".join([head, *rows])


def _style(ax):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(MUTED)
    ax.tick_params(colors=INK)


def plot_confusion_matrix(cm: np.ndarray, path: Path, title: str = "Confusion matrix") -> None:
    n = cm.shape[0]
    fig, ax = plt.subplots(figsize=(6.4, 5.6), dpi=140)
    # Counts span 0 to ~1000, so a gamma below 1 keeps the few mistakes visible next to the diagonal.
    from matplotlib.colors import PowerNorm
    im = ax.imshow(cm, cmap="Blues", norm=PowerNorm(gamma=0.35, vmin=0, vmax=max(1, cm.max())))
    for i in range(n):
        for j in range(n):
            if cm[i, j]:
                dark = im.norm(cm[i, j]) > 0.55
                ax.text(j, i, str(cm[i, j]), ha="center", va="center", fontsize=8.5,
                        color="white" if dark else INK, fontweight="bold" if i == j else "normal")
    ax.set_xticks(range(n), [str(i) for i in range(n)])
    ax.set_yticks(range(n), [str(i) for i in range(n)])
    ax.set_xlabel("Predicted digit", color=INK)
    ax.set_ylabel("True digit", color=INK)
    acc = np.trace(cm) / max(1, cm.sum())
    ax.set_title(f"{title}  ({acc:.2%} correct, n={cm.sum()})", color=INK, fontsize=11, loc="left")
    for side in ax.spines.values():
        side.set_visible(False)
    ax.tick_params(length=0, colors=INK)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def plot_misclassified(x01: np.ndarray, y_true: np.ndarray, probs: np.ndarray, path: Path, max_items: int = 32, cols: int = 8) -> int:
    """Grid of the most confidently wrong digits. Returns how many were drawn."""
    idx = misclassified(y_true, probs)[:max_items]
    total_wrong = len(misclassified(y_true, probs))
    rows = max(1, int(np.ceil(max(1, len(idx)) / cols)))
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 1.25, rows * 1.55 + 0.5), dpi=140, squeeze=False)
    for k, ax in enumerate(axes.ravel()):
        ax.axis("off")
        if k < len(idx):
            i = idx[k]
            pred = int(probs[i].argmax())
            ax.imshow(x01[i], cmap="gray_r", vmin=0, vmax=1)
            ax.set_title(f"{y_true[i]} → {pred}\n{probs[i, pred]:.0%}", fontsize=8.5, color=INK, pad=2)
    fig.suptitle(f"Misclassified: true → predicted, with the model's confidence ({len(idx)} of {total_wrong} shown)",
                 fontsize=10, color=INK, x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(path)
    plt.close(fig)
    return len(idx)


def plot_history(history: list[dict], path: Path) -> None:
    epochs = [h["epoch"] for h in history]
    fig, ax = plt.subplots(figsize=(6.4, 3.6), dpi=140)
    ax.plot(epochs, [h["train_acc"] * 100 for h in history], color=ORANGE, marker="o", ms=4, lw=2, label="train")
    ax.plot(epochs, [h["val_acc"] * 100 for h in history], color=BLUE, marker="o", ms=4, lw=2, label="validation")
    ax.set_xlabel("Epoch", color=INK)
    ax.set_ylabel("Accuracy (%)", color=INK)
    ax.set_xticks(epochs)
    ax.grid(axis="y", color=MUTED, alpha=0.25, lw=0.8)
    ax.legend(frameon=False, labelcolor=INK, loc="lower right")
    _style(ax)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
