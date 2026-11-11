"""Plot runs/loss.csv to docs/loss.png.  Usage: python plot.py"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COLORS = {"bigram": "#C25E00", "gpt": "#1F6FB5"}  # fixed per model, so colors never swap between runs


def read_log(csv_path) -> dict[str, dict[str, list[float]]]:
    series: dict[str, dict[str, list[float]]] = {}
    with Path(csv_path).open(newline="") as f:
        for row in csv.DictReader(f):
            s = series.setdefault(row["model"], {"step": [], "train": [], "val": []})
            s["step"].append(int(row["step"]))
            s["train"].append(float(row["train_loss"]))
            s["val"].append(float(row["val_loss"]))
    return series


def plot_losses(csv_path, out_path) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    series = read_log(csv_path)
    if not series:
        raise ValueError(f"{csv_path} has no rows to plot")
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=150)
    for name, s in sorted(series.items()):
        color = COLORS.get(name, "#555555")
        ax.plot(s["step"], s["val"], color=color, lw=2, label=f"{name} val")
        ax.plot(s["step"], s["train"], color=color, lw=1.5, ls="--", alpha=0.7, label=f"{name} train")
    ax.set_xlabel("training step")
    ax.set_ylabel("cross-entropy loss (nats per character)")
    ax.set_title("Bigram baseline vs GPT: train and validation loss")
    ax.grid(alpha=0.25)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.legend(frameon=False)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)
    return out


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    csv_path = argv[0] if argv else HERE / "runs" / "loss.csv"
    out = argv[1] if len(argv) > 1 else HERE / "docs" / "loss.png"
    print(f"wrote {plot_losses(csv_path, out)}")


if __name__ == "__main__":
    main()
