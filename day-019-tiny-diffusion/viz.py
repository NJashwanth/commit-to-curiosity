"""matplotlib visuals: forward-process grid, reverse GIF, real vs generated, loss curve."""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402

from datasets import DATASETS, make_dataset  # noqa: E402
from schedule import Schedule, make_schedule  # noqa: E402

ROOT = Path(__file__).resolve().parent
LIM = 3.2
POINT = "#2b6cb0"
REAL = "#c2410c"


def _style_axis(ax, title: str | None = None) -> None:
    ax.set_xlim(-LIM, LIM)
    ax.set_ylim(-LIM, LIM)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    if title:
        ax.set_title(title, fontsize=10)


def forward_timesteps(T: int) -> list[tuple[int | None, str]]:
    """Clean data plus 25%, 50%, 75% and 100% of the noising chain."""
    return [
        (None, "data (t = 0)"),
        (T // 4 - 1, f"25% noise (t = {T // 4})"),
        (T // 2 - 1, f"50% noise (t = {T // 2})"),
        (3 * T // 4 - 1, f"75% noise (t = {3 * T // 4})"),
        (T - 1, f"100% noise (t = {T})"),
    ]


def plot_forward_grid(x0: torch.Tensor, schedule: Schedule, path: Path | str, name: str = "", seed: int = 0) -> Path:
    """One row of scatter plots showing q(x_t | x_0) as the noise level rises."""
    gen = torch.Generator().manual_seed(seed)
    noise = torch.randn(x0.shape, generator=gen)  # same noise in every panel so points drift smoothly
    steps = forward_timesteps(schedule.T)
    fig, axes = plt.subplots(1, len(steps), figsize=(3 * len(steps), 3.4))
    for ax, (t, label) in zip(axes, steps):
        if t is None:
            pts = x0
        else:
            pts, _ = schedule.q_sample(x0, torch.full((len(x0),), t), noise)
        ax.scatter(pts[:, 0], pts[:, 1], s=3, color=POINT, alpha=0.7, linewidths=0)
        _style_axis(ax, label)
    fig.suptitle(f"Forward process on {name or 'data'}: the shape dissolves into Gaussian noise", fontsize=12)
    fig.tight_layout()
    return _save(fig, path)


def plot_real_vs_generated(
    pairs: dict[str, tuple[torch.Tensor, torch.Tensor]],
    path: Path | str,
    subtitle: dict[str, str] | None = None,
) -> Path:
    """One row per dataset: real points on the left, generated points on the right."""
    rows = len(pairs)
    fig, axes = plt.subplots(rows, 2, figsize=(7, 3.5 * rows), squeeze=False)
    for (name, (real, gen)), (ax_r, ax_g) in zip(pairs.items(), axes):
        ax_r.scatter(real[:, 0], real[:, 1], s=3, color=REAL, alpha=0.7, linewidths=0)
        ax_g.scatter(gen[:, 0], gen[:, 1], s=3, color=POINT, alpha=0.7, linewidths=0)
        _style_axis(ax_r, f"{name}: real")
        extra = f"\n{subtitle[name]}" if subtitle and name in subtitle else ""
        _style_axis(ax_g, f"{name}: generated{extra}")
    fig.tight_layout()
    return _save(fig, path)


def plot_loss(losses: dict[str, list[float]], path: Path | str, window: int = 100) -> Path:
    """Training loss per dataset: faint raw curve and a moving average, log scale."""
    fig, ax = plt.subplots(figsize=(7, 4))
    for i, (name, values) in enumerate(losses.items()):
        color = plt.get_cmap("tab10")(i)
        values = np.asarray(values)
        ax.plot(values, color=color, alpha=0.15, linewidth=0.6)
        w = min(window, len(values))
        smooth = np.convolve(values, np.ones(w) / w, mode="valid")
        ax.plot(np.arange(w - 1, len(values)), smooth, color=color, linewidth=1.8, label=name)
    ax.set_yscale("log")
    ax.set_xlabel("training step")
    ax.set_ylabel("noise-prediction MSE")
    ax.set_title("Training loss")
    ax.grid(alpha=0.3)
    ax.legend()
    fig.tight_layout()
    return _save(fig, path)


def _render_frame(
    points: torch.Tensor, label: str, reference: torch.Tensor | None, size: float, dpi: int
) -> Image.Image:
    fig, ax = plt.subplots(figsize=(size, size), dpi=dpi)
    if reference is not None:
        ax.scatter(reference[:, 0], reference[:, 1], s=2, color="#d1d5db", linewidths=0)
    ax.scatter(points[:, 0], points[:, 1], s=3, color=POINT, alpha=0.8, linewidths=0)
    _style_axis(ax, label)
    fig.tight_layout(pad=0.4)
    fig.canvas.draw()
    frame = Image.fromarray(np.asarray(fig.canvas.buffer_rgba())[..., :3].copy())
    plt.close(fig)
    return frame


def save_reverse_gif(
    trajectory: list[torch.Tensor],
    path: Path | str,
    title: str = "reverse process",
    reference: torch.Tensor | None = None,
    max_frames: int = 50,
    fps: int = 12,
    hold: int = 18,
    size: float = 3.6,
    dpi: int = 80,
) -> Path:
    """Render the sampler trajectory (noise -> shape) as a small, looping GIF."""
    n = len(trajectory)
    idx = np.unique(np.linspace(0, n - 1, min(max_frames, n)).round().astype(int))
    frames = []
    for i in idx:
        label = f"{title}  step {i}/{n - 1}"
        image = _render_frame(trajectory[i], label, reference, size, dpi)
        frames.append(image.quantize(colors=32, method=Image.Quantize.MEDIANCUT))
    durations = [int(1000 / fps)] * len(frames)
    durations[-1] = int(1000 / fps) * hold  # linger on the finished shape
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
    return path


def _save(fig, path: Path | str) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=110)
    plt.close(fig)
    return path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Make the data-only and training plots.")
    sub = parser.add_subparsers(dest="command", required=True)

    fwd = sub.add_parser("forward", help="forward process grid (data -> noise)")
    fwd.add_argument("--dataset", choices=DATASETS, default="jn")
    fwd.add_argument("--schedule", choices=("linear", "cosine"), default="cosine")
    fwd.add_argument("--T", type=int, default=100)
    fwd.add_argument("--n", type=int, default=1500)
    fwd.add_argument("--out", type=Path, default=None)

    loss = sub.add_parser("loss", help="loss curves from CSV logs")
    loss.add_argument("--datasets", nargs="+", choices=DATASETS, default=["spiral", "jn"])
    loss.add_argument("--log-dir", type=Path, default=ROOT / "runs")
    loss.add_argument("--out", type=Path, default=ROOT / "docs" / "loss.png")

    args = parser.parse_args(argv)
    if args.command == "forward":
        out = args.out or ROOT / "docs" / f"forward_{args.dataset}.png"
        x0 = make_dataset(args.dataset, args.n, seed=0)
        print(plot_forward_grid(x0, make_schedule(args.schedule, args.T), out, args.dataset))
    else:
        from train import read_log

        curves = {d: read_log(args.log_dir / f"{d}_loss.csv") for d in args.datasets}
        print(plot_loss(curves, args.out))


if __name__ == "__main__":
    main()
