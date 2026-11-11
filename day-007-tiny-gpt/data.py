"""Dataset download (with offline fallback), 90/10 split and batch sampling."""

from __future__ import annotations

import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import torch

from tokenizer import CharTokenizer

HERE = Path(__file__).resolve().parent
DATA_URL = "https://raw.githubusercontent.com/karpathy/char-rnn/master/data/tinyshakespeare/input.txt"
DEFAULT_DATA_DIR = HERE / "data"
FALLBACK_PATH = HERE / "assets" / "fallback.txt"
MIN_DOWNLOAD_CHARS = 1000  # anything smaller is an error page, not the dataset


def download_text(url: str = DATA_URL, timeout: float = 15.0) -> str:
    """Fetch the dataset. Raises OSError (network) or ValueError (bad content)."""
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        text = resp.read().decode("utf-8")
    if len(text) < MIN_DOWNLOAD_CHARS:
        raise ValueError(f"downloaded text is only {len(text)} chars, expected the full dataset")
    return text


def load_text(
    data_dir: str | Path = DEFAULT_DATA_DIR,
    url: str = DATA_URL,
    offline: bool = False,
    fallback_path: str | Path = FALLBACK_PATH,
) -> tuple[str, str]:
    """Return (text, source) where source is 'cache', 'download' or 'fallback'.

    Order: cached copy, then download, then the bundled public domain excerpts.
    The fallback is never cached, so the next run tries the download again.
    """
    cache = Path(data_dir) / "input.txt"
    if cache.exists():
        return cache.read_text(encoding="utf-8"), "cache"
    if not offline:
        try:
            text = download_text(url)
        except (OSError, ValueError) as err:
            print(f"download failed ({err}); using bundled fallback text", file=sys.stderr)
        else:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(text, encoding="utf-8")
            return text, "download"
    return Path(fallback_path).read_text(encoding="utf-8"), "fallback"


def split_data(ids: torch.Tensor, val_fraction: float = 0.1) -> tuple[torch.Tensor, torch.Tensor]:
    """Contiguous split (first 90% train, last 10% val)."""
    if not 0.0 < val_fraction < 1.0:
        raise ValueError("val_fraction must be between 0 and 1")
    n = int(len(ids) * (1.0 - val_fraction))
    return ids[:n], ids[n:]


def get_batch(
    data: torch.Tensor,
    batch_size: int,
    block_size: int,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Sample random windows. y is x shifted left by one (next-char targets)."""
    if len(data) <= block_size:
        raise ValueError(f"data has {len(data)} tokens, need more than block_size={block_size}")
    starts = torch.randint(len(data) - block_size, (batch_size,), generator=generator)
    x = torch.stack([data[s : s + block_size] for s in starts])
    y = torch.stack([data[s + 1 : s + block_size + 1] for s in starts])
    return x, y


@dataclass
class Dataset:
    tokenizer: CharTokenizer
    train: torch.Tensor
    val: torch.Tensor
    source: str

    @classmethod
    def from_text(cls, text: str, source: str = "text", val_fraction: float = 0.1) -> "Dataset":
        tok = CharTokenizer.from_text(text)
        ids = torch.tensor(tok.encode(text), dtype=torch.long)
        train, val = split_data(ids, val_fraction)
        return cls(tok, train, val, source)

    @classmethod
    def prepare(cls, data_dir: str | Path = DEFAULT_DATA_DIR, offline: bool = False) -> "Dataset":
        text, source = load_text(data_dir, offline=offline)
        return cls.from_text(text, source)

    def batch(self, split: str, batch_size: int, block_size: int, generator=None):
        data = {"train": self.train, "val": self.val}[split]
        return get_batch(data, batch_size, block_size, generator)
