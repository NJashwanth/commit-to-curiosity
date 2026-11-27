"""Synthetic digits rendered from system fonts: the fallback when MNIST cannot be downloaded.

Each base image is one digit in one font, put through the same MNIST-style preprocessing
as a drawing (crop, 20x20, center by mass). Every sample is then a base image with heavy
augmentation: rotation, scale, shear, shift, elastic distortion, stroke thickness, blur
and noise. The result looks like handwriting that was drawn with a marker by many people.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from augment import HEAVY, AugmentConfig, augment
from preprocess import mnist_style

FONT_DIRS = [
    "/usr/share/fonts", "/usr/local/share/fonts", "~/.fonts", "~/.local/share/fonts",
    "/Library/Fonts", "/System/Library/Fonts", "C:/Windows/Fonts",
]
FONT_SUFFIXES = {".ttf", ".otf", ".ttc"}
CANVAS = 160  # pixels; the glyph is drawn large and then scaled down like a real drawing would be
FONT_SIZE = 110


def find_fonts(dirs: list[str] | None = None) -> list[str]:
    """Sorted paths of every font file under the given directories (default: the usual system locations)."""
    found: set[str] = set()
    for d in dirs if dirs is not None else FONT_DIRS:
        root = Path(d).expanduser()
        if root.is_dir():
            found.update(str(p) for p in root.rglob("*") if p.suffix.lower() in FONT_SUFFIXES)
    return sorted(found)


def _load_font(path: str | None):
    if path is None:
        return ImageFont.load_default(size=FONT_SIZE)
    return ImageFont.truetype(path, FONT_SIZE)


def render_digit(font_path: str | None, digit: int) -> np.ndarray:
    """Draw one digit large and centered on a black canvas. Returns float (CANVAS, CANVAS) in [0, 1], ink high."""
    img = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(img).text((CANVAS / 2, CANVAS / 2), str(digit), font=_load_font(font_path), fill=255, anchor="mm")
    return np.asarray(img, dtype=np.float64) / 255.0


def base_digits(font_path: str | None) -> np.ndarray | None:
    """(10, 28, 28) MNIST-style base images for one font, or None if the font cannot draw all ten digits.

    Fonts without digit glyphs draw an empty box or nothing, which shows up as missing or identical images.
    """
    try:
        bases = np.stack([mnist_style(render_digit(font_path, d)) for d in range(10)])
    except OSError:
        return None
    if (bases.reshape(10, -1).max(axis=1) <= 0).any():
        return None
    if len({b.tobytes() for b in bases}) < 10:
        return None
    return bases


def usable_fonts(paths: list[str]) -> tuple[list[str | None], list[np.ndarray]]:
    """Keep the fonts that draw all ten digits. With no usable system font, fall back to Pillow's built-in one."""
    fonts: list[str | None] = []
    bases: list[np.ndarray] = []
    for p in paths:
        b = base_digits(p)
        if b is not None:
            fonts.append(p)
            bases.append(b)
    if not fonts:
        b = base_digits(None)
        if b is None:  # pragma: no cover (Pillow always ships a drawable default font)
            raise RuntimeError("no usable font found for the synthetic dataset")
        fonts, bases = [None], [b]
    return fonts, bases


def generate(
    n: int, seed: int, bases: list[np.ndarray], cfg: AugmentConfig = HEAVY
) -> tuple[np.ndarray, np.ndarray]:
    """n augmented digits with balanced labels: images float32 (n, 28, 28) in [0, 1], labels int64 (n,)."""
    rng = np.random.default_rng(seed)
    y = rng.permutation(np.arange(n) % 10).astype(np.int64)
    font_idx = rng.integers(0, len(bases), size=n)
    x = np.empty((n, 28, 28), dtype=np.float32)
    for i in range(n):
        x[i] = augment(bases[font_idx[i]][y[i]], rng, cfg)
    return x, y


def split_fonts(bases: list[np.ndarray], every: int = 5) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Hold out every `every`-th font for the test set, so the test set measures unseen typefaces.

    With fewer than `every` fonts there is nothing to hold out and both sides share the same fonts.
    """
    if len(bases) < every:
        return bases, bases
    test = bases[::every]
    train = [b for i, b in enumerate(bases) if i % every != 0]
    return train, test


def log(msg: str) -> None:
    print(msg, file=sys.stderr)
