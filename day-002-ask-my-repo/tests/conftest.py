"""Shared test helpers: a deterministic fake embedder so no model is ever downloaded."""
import hashlib
import math

import pytest

DIM = 32


def word_vector(text):
    """Deterministic bag-of-words embedding: each word adds weight to a hashed dimension."""
    vec = [0.0] * DIM
    for word in text.lower().split():
        digest = hashlib.md5(word.strip(".,:;()\"'").encode()).digest()
        vec[digest[0] % DIM] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


class FakeEmbedder:
    """Same interface as index.Embedder. Texts sharing words get similar vectors."""

    def __init__(self):
        self.calls = []

    def embed(self, texts):
        self.calls.append(list(texts))
        return [word_vector(t) for t in texts]


@pytest.fixture
def embedder():
    return FakeEmbedder()


@pytest.fixture
def index_root(tmp_path):
    return tmp_path / "indexes"
