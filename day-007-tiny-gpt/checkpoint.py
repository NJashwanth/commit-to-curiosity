"""Save and load a model together with its tokenizer vocab."""

from __future__ import annotations

from pathlib import Path

import torch

from models import GPT, BigramLanguageModel, GPTConfig
from tokenizer import CharTokenizer


def save_checkpoint(path, model, tokenizer: CharTokenizer, step: int = 0, val_loss: float | None = None) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "config": model.config(),
            "state_dict": {k: v.detach().cpu() for k, v in model.state_dict().items()},
            "vocab": tokenizer.to_list(),
            "step": step,
            "val_loss": val_loss,
        },
        path,
    )


def load_checkpoint(path):
    """Return (model in eval mode, tokenizer, meta dict)."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"no checkpoint at {path}. Train one first, e.g. `python train.py --steps 3000`")
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    cfg = dict(ckpt["config"])
    kind = cfg.pop("kind")
    if kind == "gpt":
        model = GPT(GPTConfig(**cfg))
    elif kind == "bigram":
        model = BigramLanguageModel(**cfg)
    else:
        raise ValueError(f"unknown model kind {kind!r} in checkpoint")
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model, CharTokenizer(ckpt["vocab"]), {"step": ckpt["step"], "val_loss": ckpt["val_loss"], "kind": kind}
