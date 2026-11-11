"""Character-level tokenizer with a saved vocab."""

from __future__ import annotations

import json
from pathlib import Path


class CharTokenizer:
    """Maps each distinct character to an integer id (sorted, so ids are stable)."""

    def __init__(self, chars: list[str] | str):
        chars = list(chars)
        if len(set(chars)) != len(chars):
            raise ValueError("vocab contains duplicate characters")
        self.chars = chars
        self.stoi = {c: i for i, c in enumerate(chars)}
        self.itos = {i: c for i, c in enumerate(chars)}

    @classmethod
    def from_text(cls, text: str) -> "CharTokenizer":
        return cls(sorted(set(text)))

    @property
    def vocab_size(self) -> int:
        return len(self.chars)

    def encode(self, text: str, errors: str = "strict") -> list[int]:
        """Turn text into ids.

        errors="strict" raises ValueError on a character outside the vocab,
        errors="ignore" silently drops it.
        """
        if errors not in ("strict", "ignore"):
            raise ValueError(f"errors must be 'strict' or 'ignore', got {errors!r}")
        ids = []
        unknown = []
        for c in text:
            i = self.stoi.get(c)
            if i is None:
                unknown.append(c)
            else:
                ids.append(i)
        if unknown and errors == "strict":
            shown = "".join(sorted(set(unknown)))
            raise ValueError(f"characters not in vocab: {shown!r}")
        return ids

    def decode(self, ids) -> str:
        """Turn ids back into text. Raises ValueError on an id outside the vocab."""
        out = []
        for i in ids:
            i = int(i)
            if i not in self.itos:
                raise ValueError(f"token id {i} is not in the vocab (size {self.vocab_size})")
            out.append(self.itos[i])
        return "".join(out)

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"chars": self.chars}, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "CharTokenizer":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(data["chars"])

    def to_list(self) -> list[str]:
        return list(self.chars)
