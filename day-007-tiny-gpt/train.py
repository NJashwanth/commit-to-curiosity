"""Train a model on tinyshakespeare (or the bundled fallback text).

    python train.py --steps 3000
    python train.py --model bigram
"""

from __future__ import annotations

import argparse
import csv
import time
from dataclasses import dataclass
from pathlib import Path

import torch

from checkpoint import save_checkpoint
from data import Dataset
from models import GPT, BigramLanguageModel, GPTConfig, count_parameters
from plot import plot_losses

HERE = Path(__file__).resolve().parent
LOG_FIELDS = ["model", "step", "train_loss", "val_loss", "tokens_per_sec"]


@dataclass
class TrainConfig:
    steps: int = 3000
    batch_size: int = 32
    block_size: int = 64
    lr: float = 3e-3
    weight_decay: float = 0.01
    eval_interval: int = 250
    eval_iters: int = 20
    seed: int = 1337


@torch.no_grad()
def estimate_loss(model, dataset: Dataset, batch_size: int, block_size: int, eval_iters: int, generator=None):
    """Average loss over eval_iters random batches for both splits."""
    model.eval()
    out = {}
    for split in ("train", "val"):
        losses = torch.zeros(eval_iters)
        for k in range(eval_iters):
            x, y = dataset.batch(split, batch_size, block_size, generator)
            _, loss = model(x, y)
            losses[k] = loss.item()
        out[split] = losses.mean().item()
    model.train()
    return out


class CsvLogger:
    """Writes runs/loss.csv. Rows from other models are kept, so a bigram run
    and a GPT run end up side by side in one file for the plot."""

    def __init__(self, path: str | Path, model_name: str):
        self.path = Path(path)
        self.model_name = model_name
        self.rows: list[dict] = []
        if self.path.exists():
            with self.path.open(newline="") as f:
                self.rows = [r for r in csv.DictReader(f) if r["model"] != model_name]
        self.mine: list[dict] = []

    def log(self, step: int, train_loss: float, val_loss: float, tokens_per_sec: float) -> None:
        self.mine.append(
            {
                "model": self.model_name,
                "step": step,
                "train_loss": f"{train_loss:.4f}",
                "val_loss": f"{val_loss:.4f}",
                "tokens_per_sec": f"{tokens_per_sec:.0f}",
            }
        )
        self._flush()

    def _flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=LOG_FIELDS)
            writer.writeheader()
            writer.writerows(self.rows + self.mine)


def train(model, dataset: Dataset, cfg: TrainConfig, log_path=None, model_name="model", on_best=None, verbose=True):
    """Run the training loop. Returns a dict with the best val loss and the last eval.

    on_best(step, val_loss) is called whenever val loss improves, which is how
    the CLI saves the best checkpoint.
    """
    torch.manual_seed(cfg.seed)
    gen = torch.Generator().manual_seed(cfg.seed)
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    logger = CsvLogger(log_path, model_name) if log_path else None
    n_params = count_parameters(model)
    if verbose:
        print(f"{model_name}: {n_params:,} parameters, vocab {dataset.tokenizer.vocab_size}, data from {dataset.source}")

    best_val = float("inf")
    last = {}
    tokens_per_step = cfg.batch_size * cfg.block_size
    window_start, window_steps = time.perf_counter(), 0
    tps = 0.0
    model.train()
    for step in range(cfg.steps + 1):
        if step % cfg.eval_interval == 0 or step == cfg.steps:
            last = estimate_loss(model, dataset, cfg.batch_size, cfg.block_size, cfg.eval_iters, gen)
            if logger:
                logger.log(step, last["train"], last["val"], tps)
            if verbose:
                print(f"step {step:5d} | train {last['train']:.4f} | val {last['val']:.4f} | {tps:,.0f} tok/s")
            if last["val"] < best_val:
                best_val = last["val"]
                if on_best:
                    on_best(step, best_val)
            window_start, window_steps = time.perf_counter(), 0  # exclude eval time from tok/s
        if step == cfg.steps:
            break
        x, y = dataset.batch("train", cfg.batch_size, cfg.block_size, gen)
        _, loss = model(x, y)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        window_steps += 1
        tps = window_steps * tokens_per_step / (time.perf_counter() - window_start)
    return {"best_val": best_val, "final": last, "params": n_params, "tokens_per_sec": tps}


def build_model(name: str, vocab_size: int, block_size=64, n_embd=128, n_head=4, n_layer=5, dropout=0.1):
    if name == "bigram":
        return BigramLanguageModel(vocab_size)
    if name == "gpt":
        return GPT(GPTConfig(vocab_size, block_size, n_embd, n_head, n_layer, dropout))
    raise ValueError(f"unknown model {name!r}")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", choices=["gpt", "bigram"], default="gpt")
    p.add_argument("--steps", type=int, default=3000)
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--block-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=None, help="default: 3e-3 for gpt, 1e-2 for bigram")
    p.add_argument("--n-embd", type=int, default=128)
    p.add_argument("--n-head", type=int, default=4)
    p.add_argument("--n-layer", type=int, default=5)
    p.add_argument("--dropout", type=float, default=0.1)
    p.add_argument("--eval-interval", type=int, default=250)
    p.add_argument("--eval-iters", type=int, default=20)
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--offline", action="store_true", help="skip the download and use the bundled text")
    p.add_argument("--data-dir", default=str(HERE / "data"))
    p.add_argument("--log", default=str(HERE / "runs" / "loss.csv"))
    p.add_argument("--ckpt-dir", default=str(HERE / "checkpoints"))
    p.add_argument("--plot", default=str(HERE / "docs" / "loss.png"), help="loss curve output path")
    p.add_argument("--no-plot", action="store_true")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    dataset = Dataset.prepare(args.data_dir, offline=args.offline)
    torch.manual_seed(args.seed)
    model = build_model(
        args.model, dataset.tokenizer.vocab_size, args.block_size, args.n_embd, args.n_head, args.n_layer, args.dropout
    )
    lr = args.lr if args.lr is not None else (1e-2 if args.model == "bigram" else 3e-3)
    cfg = TrainConfig(
        steps=args.steps,
        batch_size=args.batch_size,
        block_size=args.block_size,
        lr=lr,
        eval_interval=args.eval_interval,
        eval_iters=args.eval_iters,
        seed=args.seed,
    )
    ckpt_path = Path(args.ckpt_dir) / f"{args.model}.pt"

    def save_best(step, val_loss):
        save_checkpoint(ckpt_path, model, dataset.tokenizer, step, val_loss)

    dataset.tokenizer.save(Path(args.ckpt_dir) / "vocab.json")
    result = train(model, dataset, cfg, log_path=args.log, model_name=args.model, on_best=save_best)
    print(f"best val loss {result['best_val']:.4f} (checkpoint: {ckpt_path})")
    if not args.no_plot:
        print(f"loss curve: {plot_losses(args.log, args.plot)}")


if __name__ == "__main__":
    main()
