"""Models: a bigram baseline now, the GPT is added in the next step."""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


def count_parameters(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


class BigramLanguageModel(nn.Module):
    """Predicts the next char from the current char only.

    The whole model is one (vocab x vocab) table of logits, so it can never
    use context. It is the baseline the GPT has to beat.
    """

    kind = "bigram"

    def __init__(self, vocab_size: int):
        super().__init__()
        self.vocab_size = vocab_size
        self.block_size = 1  # only ever looks at one char
        self.table = nn.Embedding(vocab_size, vocab_size)

    def forward(self, idx: torch.Tensor, targets: torch.Tensor | None = None):
        logits = self.table(idx)  # (B, T, V)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.reshape(-1, self.vocab_size), targets.reshape(-1))
        return logits, loss

    def config(self) -> dict:
        return {"kind": self.kind, "vocab_size": self.vocab_size}
