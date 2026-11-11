"""Sample text from a trained checkpoint.

    python generate.py --prompt "ROMEO:" --tokens 400 --temperature 0.8 --top-k 40
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
import torch.nn.functional as F

from checkpoint import load_checkpoint

HERE = Path(__file__).resolve().parent


def validate_sampling(temperature: float, top_k: int | None) -> None:
    if not temperature > 0:  # also catches NaN
        raise ValueError(f"temperature must be > 0, got {temperature}")
    if top_k is not None and top_k < 1:
        raise ValueError(f"top_k must be >= 1, got {top_k}")


@torch.no_grad()
def sample(model, idx: torch.Tensor, max_new_tokens: int, temperature: float = 1.0, top_k: int | None = None, generator=None):
    """Extend idx (B, T) by max_new_tokens ids, one at a time.

    temperature < 1 sharpens the distribution, > 1 flattens it.
    top_k keeps only the k most likely ids; top_k=1 is greedy decoding.
    """
    validate_sampling(temperature, top_k)
    was_training = model.training
    model.eval()
    for _ in range(max_new_tokens):
        context = idx[:, -model.block_size :]
        logits, _ = model(context)
        logits = logits[:, -1, :] / temperature
        if top_k is not None:
            k = min(top_k, logits.size(-1))
            kth = torch.topk(logits, k).values[:, -1, None]
            logits = logits.masked_fill(logits < kth, float("-inf"))
        probs = F.softmax(logits, dim=-1)
        nxt = torch.multinomial(probs, num_samples=1, generator=generator)
        idx = torch.cat([idx, nxt], dim=1)
    model.train(was_training)
    return idx


def generate_text(model, tokenizer, prompt: str = "", max_new_tokens: int = 200, temperature: float = 1.0, top_k=None, seed: int | None = None) -> str:
    """Prompt in, prompt + continuation out. Same seed gives the same text."""
    validate_sampling(temperature, top_k)
    ids = tokenizer.encode(prompt)  # raises ValueError for chars outside the vocab
    start = len(ids)
    if not ids:  # empty prompt: seed with a newline (or id 0) and do not echo it
        ids, start = [tokenizer.stoi.get("\n", 0)], 1
    gen = torch.Generator().manual_seed(seed) if seed is not None else None
    out = sample(model, torch.tensor([ids]), max_new_tokens, temperature, top_k, gen)
    return prompt + tokenizer.decode(out[0, start:].tolist())


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", choices=["gpt", "bigram"], default="gpt", help="which default checkpoint to load")
    p.add_argument("--checkpoint", default=None, help="path to a .pt file (default: checkpoints/<model>.pt)")
    p.add_argument("--prompt", default="")
    p.add_argument("--tokens", type=int, default=400)
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--top-k", type=int, default=40)
    p.add_argument("--seed", type=int, default=None, help="set for reproducible output")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    path = args.checkpoint or HERE / "checkpoints" / f"{args.model}.pt"
    try:
        model, tok, _ = load_checkpoint(path)
        text = generate_text(model, tok, args.prompt, args.tokens, args.temperature, args.top_k, args.seed)
    except (FileNotFoundError, ValueError) as err:
        raise SystemExit(f"error: {err}")
    print(text)


if __name__ == "__main__":
    main()
