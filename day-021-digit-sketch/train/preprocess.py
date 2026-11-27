"""MNIST-style preprocessing: crop to the ink, scale to 20x20, center by center of mass in 28x28.

This is the recipe the original MNIST digits were made with, and the browser app runs the
same recipe (web/src/preprocess.ts) on whatever you draw. Both sides use plain array
maths, no image library, so a test can check that they produce the same pixels.

Conventions shared with the TypeScript version:
  * images are float arrays in [0, 1], ink is high, shape (height, width)
  * a pixel counts as ink for the bounding box when it is above INK_THRESHOLD
  * resizing is exact area averaging
  * the scaled digit is divided by its maximum, so thin strokes do not come out faint
  * the offset is floor(x + 0.5), because round-half-even differs between languages
"""
from __future__ import annotations

import math

import numpy as np

SIZE = 28          # side of the final image
BOX = 20           # the digit is scaled to fit in a BOX x BOX square
CENTER = SIZE / 2  # target center of mass, in continuous pixel coordinates
INK_THRESHOLD = 0.1


def _round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def area_weights(src: int, dst: int) -> np.ndarray:
    """(dst, src) matrix whose rows are the exact area-average weights of src cells under each dst cell."""
    w = np.zeros((dst, src), dtype=np.float64)
    ratio = src / dst
    for i in range(dst):
        lo, hi = i * ratio, (i + 1) * ratio
        for j in range(int(math.floor(lo)), min(src, int(math.ceil(hi)))):
            overlap = min(hi, j + 1) - max(lo, j)
            if overlap > 0:
                w[i, j] = overlap / ratio
    return w


def resize_area(img: np.ndarray, height: int, width: int) -> np.ndarray:
    """Area-average resize of a 2D array to (height, width)."""
    return area_weights(img.shape[0], height) @ img @ area_weights(img.shape[1], width).T


def center_of_mass(img: np.ndarray) -> tuple[float, float] | None:
    """(y, x) center of mass in continuous coordinates (pixel i covers [i, i+1]); None if the image has no ink."""
    mass = float(img.sum())
    if mass <= 0:
        return None
    ys = np.arange(img.shape[0]) + 0.5
    xs = np.arange(img.shape[1]) + 0.5
    return float((img.sum(axis=1) * ys).sum() / mass), float((img.sum(axis=0) * xs).sum() / mass)


def mnist_style(img: np.ndarray, threshold: float = INK_THRESHOLD) -> np.ndarray:
    """Turn any grayscale drawing (ink high, values in [0, 1]) into a 28x28 float32 MNIST-style image.

    An image with no ink gives an all-zero 28x28 image.
    """
    img = np.asarray(img, dtype=np.float64)
    out = np.zeros((SIZE, SIZE), dtype=np.float32)
    ys, xs = np.nonzero(img > threshold)
    if ys.size == 0:
        return out
    crop = img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = crop.shape
    scale = BOX / max(h, w)
    nh, nw = max(1, _round_half_up(h * scale)), max(1, _round_half_up(w * scale))
    small = resize_area(crop, nh, nw)
    peak = small.max()
    if peak > 0:
        small = small / peak
    cy, cx = center_of_mass(small)  # type: ignore[misc]  (small has ink)
    # Shift so the center of mass lands on the middle of the field, but keep the whole digit inside it.
    top = min(max(_round_half_up(CENTER - cy), 0), SIZE - nh)
    left = min(max(_round_half_up(CENTER - cx), 0), SIZE - nw)
    out[top : top + nh, left : left + nw] = small
    return out
