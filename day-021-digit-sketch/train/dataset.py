"""Datasets for the digit recognizer: MNIST when it can be downloaded, synthetic font digits otherwise.

Images are float32 arrays in [0, 1] with shape (N, 28, 28), labels are int64. The model sees
them normalized the MNIST way: (x - 0.1307) / 0.3081.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

import mnist
import synthetic

MNIST_MEAN = 0.1307
MNIST_STD = 0.3081

SOURCE_MNIST = "mnist"
SOURCE_SYNTHETIC = "synthetic-fonts"


@dataclass
class DigitData:
    x_train: np.ndarray
    y_train: np.ndarray
    x_val: np.ndarray
    y_val: np.ndarray
    x_test: np.ndarray
    y_test: np.ndarray
    source: str                      # SOURCE_MNIST or SOURCE_SYNTHETIC
    info: dict = field(default_factory=dict)  # where it came from, for the run record


def normalize(x: np.ndarray) -> np.ndarray:
    """MNIST-style normalization of images in [0, 1]."""
    return ((np.asarray(x, dtype=np.float32) - MNIST_MEAN) / MNIST_STD).astype(np.float32)


def denormalize(x: np.ndarray) -> np.ndarray:
    return (np.asarray(x, dtype=np.float32) * MNIST_STD + MNIST_MEAN).astype(np.float32)


def split_train_val(x: np.ndarray, y: np.ndarray, val_fraction: float, seed: int):
    """Seeded shuffle, then the last `val_fraction` becomes the validation set."""
    if not 0.0 < val_fraction < 1.0:
        raise ValueError("val_fraction must be between 0 and 1")
    order = np.random.default_rng(seed).permutation(len(x))
    n_val = max(1, int(round(len(x) * val_fraction)))
    val_idx, train_idx = order[:n_val], order[n_val:]
    return x[train_idx], y[train_idx], x[val_idx], y[val_idx]


def load_mnist_data(data_dir: Path, seed: int, val_fraction: float, fetcher=mnist.fetch, verify: bool = True) -> DigitData:
    x_tr, y_tr, x_te, y_te = mnist.load_mnist(data_dir, fetcher=fetcher, verify=verify)
    x_tr = x_tr.astype(np.float32) / 255.0
    x_te = x_te.astype(np.float32) / 255.0
    xt, yt, xv, yv = split_train_val(x_tr, y_tr.astype(np.int64), val_fraction, seed)
    info = {"name": SOURCE_MNIST, "mirror": mnist.MIRROR, "train": len(xt), "val": len(xv), "test": len(x_te)}
    return DigitData(xt, yt, xv, yv, x_te, y_te.astype(np.int64), SOURCE_MNIST, info)


def load_synthetic_data(seed: int, val_fraction: float, n_train: int = 30000, n_test: int = 5000, font_paths: list[str] | None = None) -> DigitData:
    paths = synthetic.find_fonts() if font_paths is None else font_paths
    fonts, bases = synthetic.usable_fonts(paths)
    train_bases, test_bases = synthetic.split_fonts(bases)
    seeds = np.random.SeedSequence(seed).spawn(2)
    x, y = synthetic.generate(n_train, int(seeds[0].generate_state(1)[0]), train_bases)
    x_te, y_te = synthetic.generate(n_test, int(seeds[1].generate_state(1)[0]), test_bases)
    xt, yt, xv, yv = split_train_val(x, y, val_fraction, seed)
    info = {
        "name": SOURCE_SYNTHETIC, "fonts_usable": len(fonts), "fonts_scanned": len(paths),
        "fonts_held_out_for_test": len(test_bases) if len(bases) >= 5 else 0,
        "train": len(xt), "val": len(xv), "test": len(x_te),
    }
    return DigitData(xt, yt, xv, yv, x_te, y_te, SOURCE_SYNTHETIC, info)


def load_dataset(
    source: str = "auto",
    data_dir: str | Path = "data",
    seed: int = 0,
    val_fraction: float = 0.1,
    n_synthetic: tuple[int, int] = (30000, 5000),
    fetcher=mnist.fetch,
    verify: bool = True,
    font_paths: list[str] | None = None,
) -> DigitData:
    """Load a dataset. source is "mnist", "synthetic", or "auto" (MNIST first, synthetic if the download fails)."""
    if source not in ("auto", "mnist", "synthetic"):
        raise ValueError(f"unknown source {source!r}; use auto, mnist or synthetic")
    reason = None
    if source in ("auto", "mnist"):
        try:
            return load_mnist_data(Path(data_dir), seed, val_fraction, fetcher=fetcher, verify=verify)
        except Exception as exc:  # network blocked, bad checksum, truncated file...
            if source == "mnist":
                raise
            reason = f"{type(exc).__name__}: {exc}"
            synthetic.log(f"MNIST download failed ({reason}); falling back to synthetic font digits")
    data = load_synthetic_data(seed, val_fraction, n_train=n_synthetic[0], n_test=n_synthetic[1], font_paths=font_paths)
    if reason:
        data.info["fallback_reason"] = reason
    return data
