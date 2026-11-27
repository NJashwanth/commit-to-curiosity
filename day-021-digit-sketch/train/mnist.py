"""Download and parse MNIST from a GitHub-hosted mirror.

The files are the original IDX archives, served by raw.githubusercontent.com from the
`fgnt/mnist` repository. Each download is checked against the well-known MD5 of the
official file, so a proxy error page or a truncated download can never be mistaken for data.
"""
from __future__ import annotations

import gzip
import hashlib
import struct
import urllib.request
from pathlib import Path

import numpy as np

MIRROR = "https://raw.githubusercontent.com/fgnt/mnist/master"

# name -> md5 of the .gz archive itself (the same values torchvision checks)
FILES = {
    "train-images-idx3-ubyte.gz": "f68b3c2dcbeaaa9fbdd348bbdeb94873",
    "train-labels-idx1-ubyte.gz": "d53e105ee54ea40749a09fcbcd1e9432",
    "t10k-images-idx3-ubyte.gz": "9fb629c4189551a2d022fa330f9573f3",
    "t10k-labels-idx1-ubyte.gz": "ec29112dd5afa0611ce80d1b7f02629c",
}

IMAGE_MAGIC = 0x0803
LABEL_MAGIC = 0x0801


def parse_idx(raw: bytes) -> np.ndarray:
    """Parse an (already decompressed) IDX file into a uint8 array."""
    if len(raw) < 8:
        raise ValueError("IDX data is too short")
    magic, count = struct.unpack(">II", raw[:8])
    if magic == LABEL_MAGIC:
        body = np.frombuffer(raw, dtype=np.uint8, offset=8)
        if body.size != count:
            raise ValueError(f"IDX labels: header says {count}, found {body.size}")
        return body.copy()
    if magic == IMAGE_MAGIC:
        rows, cols = struct.unpack(">II", raw[8:16])
        body = np.frombuffer(raw, dtype=np.uint8, offset=16)
        if body.size != count * rows * cols:
            raise ValueError(f"IDX images: header says {count}x{rows}x{cols}, found {body.size} bytes")
        return body.reshape(count, rows, cols).copy()
    raise ValueError(f"unknown IDX magic number 0x{magic:04x}")


def _md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def fetch(url: str, timeout: float = 30.0) -> bytes:
    """Download one URL. Kept separate so tests can replace it."""
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (fixed https mirror)
        return resp.read()


def ensure_files(data_dir: Path, base_url: str = MIRROR, verify: bool = True, fetcher=fetch) -> dict[str, Path]:
    """Make sure the four archives are in `data_dir` (downloading what is missing) and return their paths."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for name, digest in FILES.items():
        path = data_dir / name
        if path.exists() and (not verify or _md5(path.read_bytes()) == digest):
            paths[name] = path
            continue
        blob = fetcher(f"{base_url}/{name}")
        if verify and _md5(blob) != digest:
            raise ValueError(f"checksum mismatch for {name}: got {_md5(blob)}, expected {digest}")
        gzip.decompress(blob)  # raises OSError if it is not gzip at all (e.g. a proxy error page)
        path.write_bytes(blob)
        paths[name] = path
    return paths


def load_mnist(data_dir: Path, base_url: str = MIRROR, verify: bool = True, fetcher=fetch):
    """Return (x_train, y_train, x_test, y_test) as uint8 arrays: images (N, 28, 28), labels (N,)."""
    paths = ensure_files(data_dir, base_url=base_url, verify=verify, fetcher=fetcher)

    def read(name: str) -> np.ndarray:
        return parse_idx(gzip.decompress(paths[name].read_bytes()))

    return (
        read("train-images-idx3-ubyte.gz"),
        read("train-labels-idx1-ubyte.gz"),
        read("t10k-images-idx3-ubyte.gz"),
        read("t10k-labels-idx1-ubyte.gz"),
    )
