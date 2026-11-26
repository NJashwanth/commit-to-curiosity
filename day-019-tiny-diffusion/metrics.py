"""Sample-quality metrics for point clouds: Chamfer distance and MMD."""

from __future__ import annotations

import torch

from datasets import make_dataset


def _cdist(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    # the direct formula avoids the matmul shortcut's rounding error (self-distance is exactly 0)
    return torch.cdist(a, b, compute_mode="donot_use_mm_for_euclid_dist")


def chamfer_distance(a: torch.Tensor, b: torch.Tensor) -> float:
    """Symmetric Chamfer distance: mean nearest-neighbour distance a->b plus b->a."""
    d = _cdist(a, b)
    return (d.min(dim=1).values.mean() + d.min(dim=0).values.mean()).item()


def mmd(a: torch.Tensor, b: torch.Tensor, bandwidths=(0.05, 0.1, 0.2, 0.5, 1.0)) -> float:
    """Biased squared MMD with a sum of RBF kernels; exactly 0 when a and b are identical."""
    def k(x, y):
        d2 = _cdist(x, y) ** 2
        return sum(torch.exp(-d2 / (2 * h * h)) for h in bandwidths) / len(bandwidths)

    return (k(a, a).mean() + k(b, b).mean() - 2 * k(a, b).mean()).item()


def gaussian_baseline(real: torch.Tensor, n: int, seed: int = 0) -> torch.Tensor:
    """Random Gaussian cloud matching the real data's mean and per-axis std."""
    gen = torch.Generator().manual_seed(seed)
    return real.mean(0) + real.std(0) * torch.randn(n, real.shape[1], generator=gen)


def evaluate(dataset: str, generated: torch.Tensor, seed: int = 123) -> dict[str, float]:
    """Score ``generated`` against fresh real samples, a second real sample and a Gaussian.

    The "real" rows are a noise floor: two independent draws of the true data
    set cannot be closer than this, so a good model lands near it.
    """
    n = generated.shape[0]
    real = make_dataset(dataset, n, seed=seed)
    other_real = make_dataset(dataset, n, seed=seed + 1)
    noise = gaussian_baseline(real, n, seed=seed)
    return {
        "chamfer": chamfer_distance(generated, real),
        "mmd": mmd(generated, real),
        "real_chamfer": chamfer_distance(other_real, real),
        "real_mmd": mmd(other_real, real),
        "gaussian_chamfer": chamfer_distance(noise, real),
        "gaussian_mmd": mmd(noise, real),
    }
