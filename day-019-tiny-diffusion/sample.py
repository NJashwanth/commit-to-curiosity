"""Reverse-process samplers: full DDPM ancestral sampling and fewer-step DDIM."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import torch

from datasets import DATASETS, make_dataset
from metrics import evaluate
from schedule import Schedule
from train import ROOT, load_checkpoint

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


def run_sampler(model, schedule: Schedule, sampler: str, n: int, steps: int, seed: int, trajectory: bool = False):
    if sampler == "ddpm":
        return ddpm_sample(model, schedule, n, seed=seed, return_trajectory=trajectory)
    return ddim_sample(model, schedule, n, steps=steps, seed=seed, return_trajectory=trajectory)


def _format_metrics(label: str, res: dict[str, float], seconds: float | None = None) -> str:
    took = f"  ({seconds:.2f}s)" if seconds is not None else ""
    return f"{label:<22} chamfer {res['chamfer']:.4f}   mmd {res['mmd']:.5f}{took}"


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Sample from a trained model and score the result.")
    p.add_argument("--dataset", choices=DATASETS, default="jn")
    p.add_argument("--n", type=int, default=2000, help="number of points to generate")
    p.add_argument("--sampler", choices=("ddpm", "ddim"), default="ddim")
    p.add_argument("--sampling-steps", type=int, default=50, help="DDIM steps (DDPM always uses all T)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--ckpt", type=Path, default=None, help="default: checkpoints/<dataset>.pt")
    p.add_argument("--gif", type=Path, default=None, help="save the reverse-process GIF here")
    p.add_argument("--plot", type=Path, default=None, help="save a real vs generated plot here")
    p.add_argument("--compare", action="store_true", help="score DDPM and DDIM side by side")
    args = p.parse_args(argv)

    model, schedule, _ = load_checkpoint(args.ckpt or ROOT / "checkpoints" / f"{args.dataset}.pt")
    steps = min(args.sampling_steps, schedule.T)
    metric_seed = 123  # fixed so every sampler is scored against the same real reference

    if args.compare:
        runs = {f"DDPM ({schedule.T} steps)": ("ddpm", schedule.T), f"DDIM ({steps} steps)": ("ddim", steps)}
    else:
        label = f"DDPM ({schedule.T} steps)" if args.sampler == "ddpm" else f"DDIM ({steps} steps)"
        runs = {label: (args.sampler, steps)}

    generated = None
    for label, (sampler, k) in runs.items():
        start = time.perf_counter()
        x = run_sampler(model, schedule, sampler, args.n, k, args.seed)
        res = evaluate(args.dataset, x, seed=metric_seed)
        print(_format_metrics(label, res, time.perf_counter() - start))
        generated = x if generated is None or sampler == args.sampler else generated
    print(_format_metrics("real vs real (floor)", {"chamfer": res["real_chamfer"], "mmd": res["real_mmd"]}))
    print(_format_metrics("gaussian baseline", {"chamfer": res["gaussian_chamfer"], "mmd": res["gaussian_mmd"]}))

    from viz import plot_real_vs_generated, save_reverse_gif

    if args.plot:
        real = make_dataset(args.dataset, args.n, seed=metric_seed)
        plot_real_vs_generated({args.dataset: (real, generated)}, args.plot)
        print(f"saved {args.plot}")
    if args.gif:
        _, traj = run_sampler(model, schedule, args.sampler, min(args.n, 1000), steps, args.seed, trajectory=True)
        reference = make_dataset(args.dataset, 1000, seed=metric_seed)
        title = f"{args.dataset} ({args.sampler.upper()})"
        save_reverse_gif(traj, args.gif, title=title, reference=reference)
        print(f"saved {args.gif} ({args.gif.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
