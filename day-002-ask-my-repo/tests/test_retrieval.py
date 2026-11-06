"""Retrieval ranks chunks by cosine similarity (embedder mocked with fixed vectors)."""
import pytest

from chunker import Chunk
from index import build_index, open_index
from retrieval import TOP_K, Hit, retrieve


class FixedEmbedder:
    """Maps each text to a hand-picked 2D vector so the expected ranking is known."""

    def __init__(self, vectors):
        self.vectors = vectors

    def embed(self, texts):
        out = []
        for t in texts:
            key = t.split("\n", 1)[-1]          # chunk texts arrive as "path\nbody"
            out.append(self.vectors[key])
        return out


VECTORS = {
    "query": [1.0, 0.0],
    "exact": [1.0, 0.0],      # cos 1.0
    "close": [0.8, 0.6],      # cos 0.8
    "orthogonal": [0.0, 1.0],  # cos 0.0
    "opposite": [-1.0, 0.0],  # cos -1.0
}


@pytest.fixture
def collection(index_root):
    chunks = [Chunk(f"{name}.py", 1, 10 + i, name) for i, name in
              enumerate(["orthogonal", "exact", "opposite", "close"])]   # deliberately shuffled
    emb = FixedEmbedder(VECTORS)
    build_index("demo", chunks, emb, root=index_root)
    return open_index("demo", root=index_root), emb


def test_results_are_ranked_by_similarity(collection):
    col, emb = collection
    hits = retrieve("query", col, emb, k=4)
    assert [h.text for h in hits] == ["exact", "close", "orthogonal", "opposite"]
    assert [h.score for h in hits] == pytest.approx([1.0, 0.8, 0.0, -1.0], abs=1e-3)


def test_hits_carry_path_and_line_range(collection):
    col, emb = collection
    best = retrieve("query", col, emb, k=1)[0]
    assert isinstance(best, Hit)
    assert (best.path, best.start_line, best.end_line) == ("exact.py", 1, 11)
    assert best.ref == "exact.py:1-11"


def test_k_limits_results(collection):
    col, emb = collection
    assert [h.text for h in retrieve("query", col, emb, k=2)] == ["exact", "close"]


def test_k_larger_than_index_returns_everything(collection):
    col, emb = collection
    assert len(retrieve("query", col, emb, k=50)) == 4


def test_default_is_top_six(index_root):
    chunks = [Chunk(f"f{i}.py", 1, 1, f"w{i}") for i in range(10)]
    vecs = {"query": [1.0, 0.0], **{f"w{i}": [1.0, i / 10] for i in range(10)}}
    emb = FixedEmbedder(vecs)
    build_index("ten", chunks, emb, root=index_root)
    hits = retrieve("query", open_index("ten", root=index_root), emb)
    assert TOP_K == 6 and len(hits) == 6
    assert [h.text for h in hits] == [f"w{i}" for i in range(6)]


def test_blank_question_returns_nothing_and_skips_embedding(collection):
    col, _ = collection

    class Boom:
        def embed(self, texts):
            raise AssertionError("should not embed a blank question")

    assert retrieve("   ", col, Boom()) == []


def test_empty_index_returns_nothing(index_root):
    import chromadb
    from chromadb.config import Settings
    client = chromadb.PersistentClient(path=str(index_root / "e"), settings=Settings(anonymized_telemetry=False))
    col = client.create_collection("chunks", embedding_function=None)
    assert retrieve("anything", col, FixedEmbedder({})) == []
