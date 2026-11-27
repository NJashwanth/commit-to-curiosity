import gzip
import struct

import numpy as np
import pytest

import mnist
import synthetic


@pytest.fixture(scope="session")
def font_paths():
    """A few system fonts keep the tests fast; with none installed the Pillow default font is used."""
    return synthetic.find_fonts()[:8]


@pytest.fixture(scope="session")
def bases(font_paths):
    return synthetic.usable_fonts(font_paths)[1]


def idx_images(arr: np.ndarray) -> bytes:
    n, h, w = arr.shape
    return struct.pack(">IIII", mnist.IMAGE_MAGIC, n, h, w) + arr.astype(np.uint8).tobytes()


def idx_labels(arr: np.ndarray) -> bytes:
    return struct.pack(">II", mnist.LABEL_MAGIC, len(arr)) + arr.astype(np.uint8).tobytes()


@pytest.fixture
def fake_mnist():
    """A tiny stand-in for the four MNIST archives, served by a fake `fetcher` (no network)."""
    rng = np.random.default_rng(0)
    imgs_tr = rng.integers(0, 256, (60, 28, 28))
    labs_tr = np.arange(60) % 10
    imgs_te = rng.integers(0, 256, (20, 28, 28))
    labs_te = np.arange(20) % 10
    blobs = {
        "train-images-idx3-ubyte.gz": gzip.compress(idx_images(imgs_tr)),
        "train-labels-idx1-ubyte.gz": gzip.compress(idx_labels(labs_tr)),
        "t10k-images-idx3-ubyte.gz": gzip.compress(idx_images(imgs_te)),
        "t10k-labels-idx1-ubyte.gz": gzip.compress(idx_labels(labs_te)),
    }
    calls = []

    def fetcher(url: str) -> bytes:
        calls.append(url)
        return blobs[url.rsplit("/", 1)[1]]

    fetcher.calls = calls
    fetcher.blobs = blobs
    fetcher.imgs_tr, fetcher.labs_tr, fetcher.imgs_te, fetcher.labs_te = imgs_tr, labs_tr, imgs_te, labs_te
    return fetcher
