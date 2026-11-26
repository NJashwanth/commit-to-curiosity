"""Reverse-process samplers: full DDPM ancestral sampling and fewer-step DDIM."""

from __future__ import annotations

import numpy as np
import torch

from schedule import Schedule

CLIP = 5.0  # predicted x_0 is clamped to [-CLIP, CLIP]; data lives within about +-3


def _predict_x0(model, schedule: Schedule, x: torch.Tensor, t: int, clip: float | None):
    tt = torch.full((x.shape[0],), t, dtype=torch.long)
    eps = model(x, tt)
    ab = schedule.alpha_bars[t]
    x0 = (x - (1 - ab).sqrt() * eps) / ab.sqrt()
    if clip is not None:
        x0 = x0.clamp(-clip, clip)
        eps = (x - ab.sqrt() * x0) / (1 - ab).sqrt()  # keep eps consistent with clipped x0
    return x0, eps


@torch.no_grad()
def ddpm_sample(
    model,
    schedule: Schedule,
    n: int,
    seed: int = 0,
    clip: float | None = CLIP,
    return_trajectory: bool = False,
):
    """Ancestral sampling over all T steps: x_T ~ N(0, I) -> x_0.

    Returns ``x_0`` of shape (n, 2), or ``(x_0, trajectory)`` where ``trajectory``
    is the list of states ``[x_T, x_{T-1}, ..., x_0]`` (length T + 1).
    """
    gen = torch.Generator().manual_seed(seed)
    x = torch.randn(n, 2, generator=gen)
    traj = [x.clone()] if return_trajectory else None
    for t in reversed(range(schedule.T)):
        x0, _ = _predict_x0(model, schedule, x, t, clip)
        ab, ab_prev, beta, alpha = (schedule.alpha_bars[t], schedule.alpha_bars_prev[t],
                                    schedule.betas[t], schedule.alphas[t])
        mean = (ab_prev.sqrt() * beta / (1 - ab)) * x0 + (alpha.sqrt() * (1 - ab_prev) / (1 - ab)) * x
        if t > 0:
            x = mean + schedule.posterior_variance[t].sqrt() * torch.randn(n, 2, generator=gen)
        else:
            x = mean
        if traj is not None:
            traj.append(x.clone())
    return (x, traj) if return_trajectory else x


def ddim_timesteps(T: int, steps: int) -> list[int]:
    """``steps`` evenly spaced timesteps from T-1 down to 0, all distinct."""
    if not 1 <= steps <= T:
        raise ValueError(f"sampling steps must be between 1 and T={T}, got {steps}")
    ts = np.linspace(0, T - 1, steps).round().astype(int)
    return [int(t) for t in ts[::-1]]


@torch.no_grad()
def ddim_sample(
    model,
    schedule: Schedule,
    n: int,
    steps: int = 50,
    seed: int = 0,
    eta: float = 0.0,
    clip: float | None = CLIP,
    return_trajectory: bool = False,
):
    """DDIM sampling with ``steps`` model evaluations (eta=0 is deterministic given x_T).

    Returns ``x_0``, or ``(x_0, trajectory)`` with ``steps + 1`` states.
    """
    ts = ddim_timesteps(schedule.T, steps)
    gen = torch.Generator().manual_seed(seed)
    x = torch.randn(n, 2, generator=gen)
    traj = [x.clone()] if return_trajectory else None
    for i, t in enumerate(ts):
        x0, eps = _predict_x0(model, schedule, x, t, clip)
        ab = schedule.alpha_bars[t]
        ab_prev = schedule.alpha_bars[ts[i + 1]] if i + 1 < len(ts) else torch.tensor(1.0)
        sigma = eta * ((1 - ab_prev) / (1 - ab)).sqrt() * (1 - ab / ab_prev).sqrt()
        direction = (1 - ab_prev - sigma**2).clamp(min=0).sqrt() * eps
        x = ab_prev.sqrt() * x0 + direction
        if eta > 0:
            x = x + sigma * torch.randn(n, 2, generator=gen)
        if traj is not None:
            traj.append(x.clone())
    return (x, traj) if return_trajectory else x
