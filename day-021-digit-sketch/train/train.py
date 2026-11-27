"""Train the digit CNN on CPU.

    python train.py --epochs 8

Writes everything to --out-dir (default runs/latest): model.pt, metrics.json and three plots.
The dataset source (real MNIST or the synthetic font fallback) is recorded in metrics.json.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

import augment as aug
import dataset as ds
import evaluate as ev
from model import DigitCNN, count_params


def pick_augmentation(name: str, source: str) -> aug.AugmentConfig | None:
    """auto: light augmentation on top of real MNIST; none for synthetic digits (already heavily augmented)."""
    if name == "auto":
        name = "light" if source == ds.SOURCE_MNIST else "none"
    return {"none": None, "light": aug.LIGHT, "heavy": aug.HEAVY}[name]


def train(
    data: ds.DigitData,
    epochs: int = 8,
    batch_size: int = 128,
    lr: float = 1e-3,
    seed: int = 0,
    augmentation: aug.AugmentConfig | None = None,
    log=print,
) -> tuple[DigitCNN, list[dict], dict]:
    """Train with Adam. Returns (model with the best-validation weights, per-epoch history, the best epoch's record)."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    model = DigitCNN()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()
    history: list[dict] = []
    best, best_state = None, None

    for epoch in range(1, epochs + 1):
        t0 = time.time()
        x = aug.augment_batch(data.x_train, rng, augmentation) if augmentation else data.x_train
        xt = torch.from_numpy(ds.normalize(x)).unsqueeze(1)
        yt = torch.from_numpy(data.y_train)
        order = torch.from_numpy(rng.permutation(len(xt)))
        model.train()
        total_loss, correct = 0.0, 0
        for i in range(0, len(order), batch_size):
            idx = order[i : i + batch_size]
            logits = model(xt[idx])
            loss = loss_fn(logits, yt[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total_loss += loss.item() * len(idx)
            correct += (logits.argmax(1) == yt[idx]).sum().item()
        val_probs = ev.predict_probs(model, data.x_val)
        record = {
            "epoch": epoch,
            "train_loss": total_loss / len(order),
            "train_acc": correct / len(order),
            "val_acc": ev.accuracy(data.y_val, val_probs.argmax(1)),
            "seconds": round(time.time() - t0, 1),
        }
        history.append(record)
        log(f"epoch {epoch:>2}/{epochs}  loss {record['train_loss']:.4f}  train acc {record['train_acc']:.4f}  "
            f"val acc {record['val_acc']:.4f}  ({record['seconds']}s)")
        if best is None or record["val_acc"] > best["val_acc"]:
            best, best_state = record, {k: v.clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_state)
    return model, history, best


def run(args: argparse.Namespace, log=print) -> dict:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    data = ds.load_dataset(args.source, data_dir=args.data_dir, seed=args.seed, val_fraction=args.val_fraction,
                           n_synthetic=(args.synthetic_train, args.synthetic_test))
    if args.limit_train:
        data.x_train, data.y_train = data.x_train[: args.limit_train], data.y_train[: args.limit_train]
    log(f"dataset source: {data.source}  {data.info}")
    cfg = pick_augmentation(args.augment, data.source)
    model, history, best = train(data, args.epochs, args.batch_size, args.lr, args.seed, cfg, log=log)

    val_probs = ev.predict_probs(model, data.x_val)
    test_probs = ev.predict_probs(model, data.x_test)
    val_cm = ev.confusion_matrix(data.y_val, val_probs.argmax(1))
    test_cm = ev.confusion_matrix(data.y_test, test_probs.argmax(1))
    metrics = {
        "dataset": {"source": data.source, **data.info},
        "model": {"params": count_params(model), **model.config()},
        "training": {"epochs": args.epochs, "batch_size": args.batch_size, "lr": args.lr, "seed": args.seed,
                     "optimizer": "Adam", "augmentation": args.augment, "best_epoch": best["epoch"]},
        "history": history,
        "val_accuracy": ev.accuracy(data.y_val, val_probs.argmax(1)),
        "test_accuracy": ev.accuracy(data.y_test, test_probs.argmax(1)),
        "val_confusion_matrix": val_cm.tolist(),
        "test_confusion_matrix": test_cm.tolist(),
    }
    torch.save({"state_dict": model.state_dict(), "config": model.config(), "metrics": metrics}, out_dir / "model.pt")
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    ev.plot_history(history, out_dir / "training_curve.png")
    ev.plot_confusion_matrix(val_cm, out_dir / "confusion_matrix.png", title="Validation confusion matrix")
    shown = ev.plot_misclassified(data.x_val, data.y_val, val_probs, out_dir / "misclassified.png")
    log(f"\nvalidation accuracy: {metrics['val_accuracy']:.4f}   test accuracy: {metrics['test_accuracy']:.4f}   "
        f"params: {metrics['model']['params']:,}   source: {data.source}")
    log("validation confusion matrix:\n" + ev.format_confusion(val_cm))
    log(f"wrote {out_dir}/ (model.pt, metrics.json, 3 plots; {shown} misclassified digits plotted)")
    return metrics


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--epochs", type=int, default=8)
    p.add_argument("--source", choices=["auto", "mnist", "synthetic"], default="auto",
                   help="auto tries MNIST first and falls back to synthetic font digits")
    p.add_argument("--augment", choices=["auto", "none", "light", "heavy"], default="auto")
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--val-fraction", type=float, default=0.1)
    p.add_argument("--data-dir", default="data")
    p.add_argument("--out-dir", default="runs/latest")
    p.add_argument("--synthetic-train", type=int, default=30000)
    p.add_argument("--synthetic-test", type=int, default=5000)
    p.add_argument("--limit-train", type=int, default=0, help="use only the first N training images (for quick runs)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    torch.set_num_threads(max(1, torch.get_num_threads()))
    run(parse_args(argv))


if __name__ == "__main__":
    main()
