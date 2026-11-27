"""Image augmentation for 28x28 digits, in plain NumPy.

One call to `augment` applies, in this order:
  1. a geometric warp: rotation, isotropic scale, shear and shift, plus an elastic distortion,
     all sampled with a single bilinear lookup
  2. stroke thickness: blend towards a 3x3 grey dilation (thicker) or erosion (thinner)
  3. gaussian blur
  4. additive gaussian noise, clipped back to [0, 1]

Every range lives in an `AugmentConfig`, every random draw in an `AugmentParams`, so a test
can sample thousands of parameter sets and check that none leave the configured bounds.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

SIZE = 28
CENTER = (SIZE - 1) / 2  # pixel-index center, 13.5


@dataclass(frozen=True)
class AugmentConfig:
    rotation_deg: float = 15.0              # rotation drawn uniformly from [-r, r]
    scale: tuple[float, float] = (0.85, 1.15)
    shear_deg: float = 10.0                 # horizontal shear drawn from [-s, s]
    shift_px: float = 2.0                   # shift in x and y drawn from [-s, s]
    elastic_px: float = 1.5                 # largest elastic displacement, in pixels
    elastic_sigma: float = 3.0              # smoothness of the displacement field
    thickness: tuple[float, float] = (-0.5, 1.0)  # <0 thinner, >0 thicker, 0 unchanged
    blur_sigma: tuple[float, float] = (0.0, 0.7)
    noise_std: float = 0.06                 # noise sigma is drawn from [0, noise_std]


# Light augmentation, used on top of real MNIST while training.
LIGHT = AugmentConfig(
    rotation_deg=10.0, scale=(0.9, 1.1), shear_deg=6.0, shift_px=1.5, elastic_px=1.0,
    thickness=(-0.4, 0.8), blur_sigma=(0.0, 0.5), noise_std=0.03,
)
# Heavy augmentation, used for the synthetic font digits (a handful of fonts need a lot of variety).
HEAVY = AugmentConfig(
    rotation_deg=20.0, scale=(0.8, 1.2), shear_deg=15.0, shift_px=2.5, elastic_px=2.0,
    thickness=(-0.6, 1.0), blur_sigma=(0.0, 0.9), noise_std=0.10,
)


@dataclass(frozen=True)
class AugmentParams:
    angle_deg: float
    scale: float
    shear_deg: float
    shift_x: float
    shift_y: float
    thickness: float
    blur_sigma: float
    noise_std: float


IDENTITY = AugmentParams(0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)


def sample_params(rng: np.random.Generator, cfg: AugmentConfig = HEAVY) -> AugmentParams:
    u = rng.uniform
    return AugmentParams(
        angle_deg=u(-cfg.rotation_deg, cfg.rotation_deg),
        scale=u(*cfg.scale),
        shear_deg=u(-cfg.shear_deg, cfg.shear_deg),
        shift_x=u(-cfg.shift_px, cfg.shift_px),
        shift_y=u(-cfg.shift_px, cfg.shift_px),
        thickness=u(*cfg.thickness),
        blur_sigma=u(*cfg.blur_sigma),
        noise_std=u(0.0, cfg.noise_std),
    )


def gaussian_kernel(sigma: float) -> np.ndarray:
    radius = max(1, int(math.ceil(3 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x**2) / (2 * sigma**2))
    return k / k.sum()


def gaussian_blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """Separable gaussian blur with edge padding. sigma <= 0 returns the image unchanged."""
    if sigma <= 0:
        return img
    k = gaussian_kernel(sigma)
    r = len(k) // 2
    padded = np.pad(img, r, mode="edge")
    tmp = sum(k[i] * padded[:, i : i + img.shape[1]] for i in range(len(k)))
    return sum(k[i] * tmp[i : i + img.shape[0], :] for i in range(len(k)))


def elastic_field(rng: np.random.Generator, size: int, sigma: float, max_px: float) -> tuple[np.ndarray, np.ndarray]:
    """Smooth random displacement fields (dy, dx) whose largest value is exactly max_px (or 0 if max_px is 0)."""
    fields = []
    for _ in range(2):
        f = gaussian_blur(rng.uniform(-1, 1, (size, size)), sigma)
        peak = np.abs(f).max()
        fields.append(f / peak * max_px if peak > 0 and max_px > 0 else np.zeros_like(f))
    return fields[0], fields[1]


def bilinear_sample(img: np.ndarray, ys: np.ndarray, xs: np.ndarray) -> np.ndarray:
    """Sample img at float coordinates (pixel-index space); outside the image reads as 0."""
    h, w = img.shape
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    fy, fx = ys - y0, xs - x0

    def at(y, x):
        ok = (y >= 0) & (y < h) & (x >= 0) & (x < w)
        return np.where(ok, img[np.clip(y, 0, h - 1), np.clip(x, 0, w - 1)], 0.0)

    return (
        at(y0, x0) * (1 - fy) * (1 - fx)
        + at(y0, x0 + 1) * (1 - fy) * fx
        + at(y0 + 1, x0) * fy * (1 - fx)
        + at(y0 + 1, x0 + 1) * fy * fx
    )


def warp(img: np.ndarray, p: AugmentParams, dy: np.ndarray | None = None, dx: np.ndarray | None = None) -> np.ndarray:
    """Affine warp about the image center, plus an optional elastic displacement of the sampling grid."""
    a, sh = math.radians(p.angle_deg), math.tan(math.radians(p.shear_deg))
    # forward map: out = scale * R(a) @ Shear @ (in - c) + c + t ; sampling needs its inverse.
    fwd = p.scale * np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]]) @ np.array([[1.0, sh], [0.0, 1.0]])
    inv = np.linalg.inv(fwd)
    gy, gx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    ox, oy = gx - CENTER - p.shift_x, gy - CENTER - p.shift_y
    sx = inv[0, 0] * ox + inv[0, 1] * oy + CENTER
    sy = inv[1, 0] * ox + inv[1, 1] * oy + CENTER
    if dy is not None and dx is not None:
        sy, sx = sy + dy, sx + dx
    return bilinear_sample(img, sy, sx)


def change_thickness(img: np.ndarray, t: float) -> np.ndarray:
    """t in [-1, 1]: blend towards a plus-shaped grey dilation (t>0) or erosion (t<0)."""
    t = float(np.clip(t, -1.0, 1.0))
    if t == 0:
        return img
    padded = np.pad(img, 1, mode="edge")
    neighbours = [padded[0:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, 0:-2], padded[1:-1, 2:]]
    if t > 0:
        return (1 - t) * img + t * np.maximum.reduce([img, *neighbours])
    return (1 + t) * img + (-t) * np.minimum.reduce([img, *neighbours])


def augment(img: np.ndarray, rng: np.random.Generator, cfg: AugmentConfig = HEAVY, params: AugmentParams | None = None) -> np.ndarray:
    """Augment one 28x28 image in [0, 1]. Returns float32 in [0, 1]. Pass `params` to control the warp exactly."""
    p = params if params is not None else sample_params(rng, cfg)
    dy, dx = elastic_field(rng, SIZE, cfg.elastic_sigma, cfg.elastic_px)
    out = warp(np.asarray(img, dtype=np.float64), p, dy, dx)
    out = change_thickness(out, p.thickness)
    out = gaussian_blur(out, p.blur_sigma)
    if p.noise_std > 0:
        out = out + rng.normal(0.0, p.noise_std, out.shape)
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def augment_batch(x: np.ndarray, rng: np.random.Generator, cfg: AugmentConfig = HEAVY) -> np.ndarray:
    """Augment (N, 28, 28) images, each with its own random parameters."""
    out = np.empty(x.shape, dtype=np.float32)
    for i in range(len(x)):
        out[i] = augment(x[i], rng, cfg)
    return out
