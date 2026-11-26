"""Noise schedules and the closed-form forward process q(x_t | x_0).

Timesteps are 0-indexed: index ``t`` in the arrays below is the (t+1)-th noising
step, so ``alpha_bars[0] = 1 - beta_0`` and ``alpha_bars[T-1]`` is close to zero.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch

SCHEDULES = ("linear", "cosine")


def linear_betas(T: int, beta_start: float | None = None, beta_end: float | None = None) -> torch.Tensor:
    """Linear betas. The Ho et al. 1000-step defaults are rescaled for other T."""
    beta_start = 1e-4 * 1000 / T if beta_start is None else beta_start
    beta_end = min(0.02 * 1000 / T, 0.999) if beta_end is None else beta_end  # keep betas below 1 for tiny T
    return torch.linspace(beta_start, beta_end, T, dtype=torch.float64)


def cosine_betas(T: int, s: float = 0.008, max_beta: float = 0.999) -> torch.Tensor:
    """Cosine schedule from Nichol & Dhariwal: betas derived from a cosine alpha-bar."""
    steps = torch.arange(T + 1, dtype=torch.float64)
    f = torch.cos(((steps / T) + s) / (1 + s) * math.pi / 2) ** 2
    alpha_bar = f / f[0]
    betas = 1.0 - alpha_bar[1:] / alpha_bar[:-1]
    return betas.clamp(max=max_beta)


@dataclass
class Schedule:
    """Precomputed quantities for a diffusion process with ``T`` steps."""

    kind: str
    T: int
    betas: torch.Tensor
    alphas: torch.Tensor
    alpha_bars: torch.Tensor
    alpha_bars_prev: torch.Tensor
    sqrt_alpha_bars: torch.Tensor
    sqrt_one_minus_alpha_bars: torch.Tensor
    posterior_variance: torch.Tensor

    def q_sample(self, x0: torch.Tensor, t: torch.Tensor, noise: torch.Tensor | None = None):
        """Sample x_t ~ q(x_t | x_0) = N(sqrt(abar_t) x_0, (1 - abar_t) I) in one shot.

        Returns ``(x_t, noise)`` so the noise can be used as the training target.
        """
        if noise is None:
            noise = torch.randn_like(x0)
        mean_coef = self._gather(self.sqrt_alpha_bars, t, x0)
        std_coef = self._gather(self.sqrt_one_minus_alpha_bars, t, x0)
        return mean_coef * x0 + std_coef * noise, noise

    @staticmethod
    def _gather(values: torch.Tensor, t: torch.Tensor, like: torch.Tensor) -> torch.Tensor:
        out = values.to(like.dtype)[t]
        return out.reshape(-1, *([1] * (like.dim() - 1)))


def make_schedule(kind: str = "cosine", T: int = 100) -> Schedule:
    """Build a :class:`Schedule` (float32 buffers, derived in float64 for accuracy)."""
    if kind == "linear":
        betas = linear_betas(T)
    elif kind == "cosine":
        betas = cosine_betas(T)
    else:
        raise ValueError(f"unknown schedule {kind!r}; choose from {', '.join(SCHEDULES)}")
    alphas = 1.0 - betas
    alpha_bars = torch.cumprod(alphas, dim=0)
    alpha_bars_prev = torch.cat([torch.ones(1, dtype=torch.float64), alpha_bars[:-1]])
    posterior_variance = betas * (1.0 - alpha_bars_prev) / (1.0 - alpha_bars)

    def f32(x: torch.Tensor) -> torch.Tensor:
        return x.to(torch.float32)

    return Schedule(
        kind=kind,
        T=T,
        betas=f32(betas),
        alphas=f32(alphas),
        alpha_bars=f32(alpha_bars),
        alpha_bars_prev=f32(alpha_bars_prev),
        sqrt_alpha_bars=f32(alpha_bars.sqrt()),
        sqrt_one_minus_alpha_bars=f32((1.0 - alpha_bars).sqrt()),
        posterior_variance=f32(posterior_variance),
    )
