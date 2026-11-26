"""Training loop: noise-prediction MSE, Adam, EMA of weights, CSV log, checkpoints."""

from __future__ import annotations

import argparse
import copy
import csv
from dataclasses import asdict, dataclass
from pathlib import Path

import torch
import torch.nn.functional as F

from datasets import DATASETS, make_dataset
from model import Denoiser
from schedule import SCHEDULES, Schedule, make_schedule

ROOT = Path(__file__).resolve().parent


@dataclass
class Config:
    dataset: str = "spiral"
    steps: int = 8000
    T: int = 100
    schedule: str = "cosine"
    hidden: int = 256
    n_layers: int = 4
    time_dim: int = 64
    learned_input: bool = True
    batch_size: int = 512
    lr: float = 2e-3
    ema_decay: float = 0.999
    n_data: int = 8000
    seed: int = 0


@torch.no_grad()
def ema_update(ema_model: torch.nn.Module, model: torch.nn.Module, decay: float) -> None:
    """ema <- decay * ema + (1 - decay) * current, parameter by parameter."""
    for ema_p, p in zip(ema_model.parameters(), model.parameters()):
        ema_p.mul_(decay).add_(p.detach(), alpha=1.0 - decay)


def build_model(cfg: Config) -> Denoiser:
    return Denoiser(
        hidden=cfg.hidden,
        n_layers=cfg.n_layers,
        time_dim=cfg.time_dim,
        learned_input=cfg.learned_input,
    )


def diffusion_loss(model: torch.nn.Module, schedule: Schedule, x0: torch.Tensor) -> torch.Tensor:
    """MSE between the true noise and the predicted noise at random timesteps."""
    t = torch.randint(0, schedule.T, (x0.shape[0],))
    x_t, noise = schedule.q_sample(x0, t)
    return F.mse_loss(model(x_t, t), noise)


def save_checkpoint(path: Path, ema_model: torch.nn.Module, cfg: Config, losses: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"ema": ema_model.state_dict(), "config": asdict(cfg), "losses": losses}, path)


def load_checkpoint(path: Path | str) -> tuple[Denoiser, Schedule, Config]:
    """Load the EMA model, its schedule and the training config from a checkpoint."""
    blob = torch.load(path, map_location="cpu", weights_only=True)
    cfg = Config(**blob["config"])
    model = build_model(cfg)
    model.load_state_dict(blob["ema"])
    model.eval()
    return model, make_schedule(cfg.schedule, cfg.T), cfg


def write_log(path: Path, losses: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["step", "loss"])
        writer.writerows(enumerate(losses, start=1))


def read_log(path: Path | str) -> list[float]:
    with open(path, newline="") as f:
        return [float(row["loss"]) for row in csv.DictReader(f)]


def train(
    cfg: Config,
    ckpt_dir: Path | None = None,
    log_dir: Path | None = None,
    verbose: bool = False,
) -> tuple[Denoiser, list[float]]:
    """Train a denoiser and return ``(ema_model, per_step_losses)``.

    Writes ``<ckpt_dir>/<dataset>.pt`` and ``<log_dir>/<dataset>_loss.csv`` when
    the directories are given.
    """
    torch.manual_seed(cfg.seed)
    data = make_dataset(cfg.dataset, cfg.n_data, seed=cfg.seed)
    schedule = make_schedule(cfg.schedule, cfg.T)
    model = build_model(cfg)
    ema_model = copy.deepcopy(model).requires_grad_(False)
    opt = torch.optim.Adam(model.parameters(), lr=cfg.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(cfg.steps, 1), eta_min=cfg.lr * 0.05)

    losses: list[float] = []
    for step in range(1, cfg.steps + 1):
        batch = data[torch.randint(0, len(data), (cfg.batch_size,))]
        loss = diffusion_loss(model, schedule, batch)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sched.step()
        ema_update(ema_model, model, cfg.ema_decay)
        losses.append(loss.item())
        if verbose and (step % 500 == 0 or step == 1):
            recent = sum(losses[-100:]) / len(losses[-100:])
            print(f"step {step:6d}  loss {recent:.4f}", flush=True)

    ema_model.eval()
    if ckpt_dir is not None:
        save_checkpoint(Path(ckpt_dir) / f"{cfg.dataset}.pt", ema_model, cfg, losses)
    if log_dir is not None:
        write_log(Path(log_dir) / f"{cfg.dataset}_loss.csv", losses)
    return ema_model, losses


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    d = Config()
    p = argparse.ArgumentParser(description="Train a DDPM denoiser on a 2D dataset.")
    p.add_argument("--dataset", choices=DATASETS, default=d.dataset)
    p.add_argument("--steps", type=int, default=d.steps)
    p.add_argument("--T", type=int, default=d.T, help="number of diffusion steps")
    p.add_argument("--schedule", choices=SCHEDULES, default=d.schedule)
    p.add_argument("--hidden", type=int, default=d.hidden)
    p.add_argument("--n-layers", type=int, default=d.n_layers)
    p.add_argument("--no-learned-input", action="store_true", help="concatenate x with the time embedding")
    p.add_argument("--batch-size", type=int, default=d.batch_size)
    p.add_argument("--lr", type=float, default=d.lr)
    p.add_argument("--ema-decay", type=float, default=d.ema_decay)
    p.add_argument("--n-data", type=int, default=d.n_data)
    p.add_argument("--seed", type=int, default=d.seed)
    p.add_argument("--ckpt-dir", type=Path, default=ROOT / "checkpoints")
    p.add_argument("--log-dir", type=Path, default=ROOT / "runs")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    cfg = Config(
        dataset=args.dataset, steps=args.steps, T=args.T, schedule=args.schedule,
        hidden=args.hidden, n_layers=args.n_layers, learned_input=not args.no_learned_input,
        batch_size=args.batch_size, lr=args.lr, ema_decay=args.ema_decay,
        n_data=args.n_data, seed=args.seed,
    )
    _, losses = train(cfg, ckpt_dir=args.ckpt_dir, log_dir=args.log_dir, verbose=True)
    print(f"done: final loss {sum(losses[-100:]) / len(losses[-100:]):.4f}")
    print(f"checkpoint: {args.ckpt_dir / (cfg.dataset + '.pt')}")
    print(f"loss log:   {args.log_dir / (cfg.dataset + '_loss.csv')}")


if __name__ == "__main__":
    main()
