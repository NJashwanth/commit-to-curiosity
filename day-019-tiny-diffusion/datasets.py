"""Seeded, normalized 2D point-cloud datasets for the diffusion model.

Every dataset is returned as a float32 tensor of shape (n, 2), centred at the
origin and scaled by a single scalar so the overall standard deviation is 1.
A single scalar (not one per axis) keeps the aspect ratio of each shape.
"""

from __future__ import annotations

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

DATASETS = ("moons", "swiss", "spiral", "jn")

JN_TEXT = "JN"
JN_FONT_SIZE = 160
JN_CANVAS = (280, 200)  # (width, height) in pixels


def _normalize(points: np.ndarray) -> np.ndarray:
    points = points - points.mean(axis=0, keepdims=True)
    return points / points.std()


def make_moons(n: int, rng: np.random.Generator, noise: float = 0.06) -> np.ndarray:
    """Two interleaving half circles."""
    n_top = n // 2
    n_bottom = n - n_top
    top_angle = rng.uniform(0.0, np.pi, n_top)
    bottom_angle = rng.uniform(0.0, np.pi, n_bottom)
    top = np.stack([np.cos(top_angle), np.sin(top_angle)], axis=1)
    bottom = np.stack([1.0 - np.cos(bottom_angle), 0.5 - np.sin(bottom_angle)], axis=1)
    points = np.concatenate([top, bottom], axis=0)
    points += rng.normal(0.0, noise, points.shape)
    return points[rng.permutation(n)]


def make_swiss_roll(n: int, rng: np.random.Generator, noise: float = 0.05) -> np.ndarray:
    """Top-down view of a swiss roll: one tightly wound spiral arm."""
    t = 1.5 * np.pi * (1.0 + 2.0 * rng.uniform(0.0, 1.0, n))
    points = np.stack([t * np.cos(t), t * np.sin(t)], axis=1) / 4.0
    points += rng.normal(0.0, noise, points.shape)
    return points


def make_spiral(n: int, rng: np.random.Generator, noise: float = 0.03) -> np.ndarray:
    """Two interleaved spiral arms whose radius grows linearly with angle."""
    n_a = n // 2
    n_b = n - n_a
    angle = rng.uniform(0.0, 1.0, n) * 3.5 * np.pi + 0.3
    radius = angle / (3.5 * np.pi + 0.3)
    arm = np.concatenate([np.zeros(n_a), np.full(n_b, np.pi)])
    points = np.stack(
        [radius * np.cos(angle + arm), radius * np.sin(angle + arm)], axis=1
    )
    points += rng.normal(0.0, noise, points.shape)
    return points[rng.permutation(n)]


def _load_font(size: int) -> ImageFont.ImageFont:
    """Pillow's bundled default font (no downloads), falling back to a system font."""
    try:
        return ImageFont.load_default(size=size)
    except (TypeError, OSError):  # pragma: no cover - old Pillow or no FreeType
        for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf", "Arial.ttf"):
            try:
                return ImageFont.truetype(name, size)
            except OSError:
                continue
        return ImageFont.load_default()


def jn_glyph(text: str = JN_TEXT, font_size: int = JN_FONT_SIZE) -> tuple[np.ndarray, np.ndarray, float]:
    """Render ``text`` and return ``(mask, mean_xy, scale)``.

    ``mask`` is a boolean array indexed ``[row, col]``. A pixel centre
    ``(col + .5, row + .5)`` maps to normalized coordinates with
    ``x = (col - mean_x) / scale`` and ``y = -(row - mean_y) / scale``
    (rows grow downwards in an image, so y is flipped to stand the letters up).
    """
    width, height = JN_CANVAS
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    font = _load_font(font_size)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font, stroke_width=3)
    origin = ((width - (right - left)) // 2 - left, (height - (bottom - top)) // 2 - top)
    draw.text(origin, text, font=font, fill=255, stroke_width=3, stroke_fill=255)
    mask = np.asarray(image) > 127
    rows, cols = np.nonzero(mask)
    centre = np.array([cols.mean() + 0.5, rows.mean() + 0.5])
    pixels = np.stack([cols + 0.5, rows + 0.5], axis=1)
    scale = float(((pixels - centre) ** 2).sum(axis=1).mean() / 2.0) ** 0.5
    return mask, centre, scale


def make_jn(n: int, rng: np.random.Generator) -> np.ndarray:
    """Points drawn uniformly from the area covered by the letters "JN"."""
    mask, centre, scale = jn_glyph()
    rows, cols = np.nonzero(mask)
    pick = rng.integers(0, len(rows), n)
    x = cols[pick] + rng.uniform(0.0, 1.0, n)
    y = rows[pick] + rng.uniform(0.0, 1.0, n)
    return np.stack([(x - centre[0]) / scale, -(y - centre[1]) / scale], axis=1)


_BUILDERS = {
    "moons": make_moons,
    "swiss": make_swiss_roll,
    "spiral": make_spiral,
    "jn": make_jn,
}


def make_dataset(name: str, n: int = 2000, seed: int = 0) -> torch.Tensor:
    """Return ``n`` normalized points of dataset ``name`` as a float32 (n, 2) tensor."""
    if name not in _BUILDERS:
        raise ValueError(f"unknown dataset {name!r}; choose from {', '.join(DATASETS)}")
    if n < 1:
        raise ValueError("n must be positive")
    rng = np.random.default_rng(seed)
    points = _BUILDERS[name](n, rng)
    if name != "jn":  # jn is normalized by the glyph mask statistics already
        points = _normalize(points)
    return torch.from_numpy(points.astype(np.float32))
