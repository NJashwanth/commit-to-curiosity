"""Embedder wrapper (sentence-transformers mocked) and the persisted Chroma index."""
import sys
import types

import pytest

import index
from chunker import Chunk
from index import Embedder, IndexMissingError, build_index, list_indexes, open_index


def make_chunks(n=3, prefix="f"):
    return [Chunk(f"{prefix}{i}.py", 1, 5 + i, f"def func_{i}(): return {i}") for i in range(n)]


# --- Embedder ------------------------------------------------------------------

class FakeSentenceTransformer:
    loads = []
    encode_calls = []

    def __init__(self, name):
        FakeSentenceTransformer.loads.append(name)

    def encode(self, texts, **kwargs):
        FakeSentenceTransformer.encode_calls.append((texts, kwargs))
        return [[float(len(t)), 0.5] for t in texts]


@pytest.fixture
def fake_st(monkeypatch):
    FakeSentenceTransformer.loads, FakeSentenceTransformer.encode_calls = [], []
    module = types.ModuleType("sentence_transformers")
    module.SentenceTransformer = FakeSentenceTransformer
    monkeypatch.setitem(sys.modules, "sentence_transformers", module)
    return FakeSentenceTransformer


def test_default_model_is_minilm():
    assert Embedder().model_name == "all-MiniLM-L6-v2"


def test_model_is_not_loaded_until_first_use(fake_st):
    Embedder()
    assert fake_st.loads == []


def test_embed_loads_once_and_normalises(fake_st, capsys):
    emb = Embedder()
    assert emb.embed(["ab", "abcd"]) == [[2.0, 0.5], [4.0, 0.5]]
    emb.embed(["x"])
    assert fake_st.loads == ["all-MiniLM-L6-v2"]
    _, kwargs = fake_st.encode_calls[0]
    assert kwargs["normalize_embeddings"] is True and kwargs["show_progress_bar"] is False
    assert "all-MiniLM-L6-v2" in capsys.readouterr().err   # tells the user about the download


def test_embed_empty_list_never_loads_the_model(fake_st):
    assert Embedder().embed([]) == []
    assert fake_st.loads == []


def test_embedding_text_includes_path_and_body():
    text = index.chunk_embedding_text(Chunk("src/a.py", 1, 2, "body"))
    assert text == "src/a.py\nbody"


# --- build and open ---------------------------------------------------------------

def test_build_index_stores_text_and_line_metadata(index_root, embedder):
    chunks = [Chunk("a.py", 3, 9, "alpha text"), Chunk("b.md", 1, 1, "beta text")]
    assert build_index("demo", chunks, embedder, root=index_root) == 2
    got = open_index("demo", root=index_root).get(ids=["a.py:3-9"], include=["documents", "metadatas"])
    assert got["documents"] == ["alpha text"]
    assert got["metadatas"] == [{"path": "a.py", "start_line": 3, "end_line": 9}]


def test_index_is_stored_under_the_repo_name(index_root, embedder):
    build_index("my-repo", make_chunks(), embedder, root=index_root)
    assert (index_root / "my-repo" / "chroma.sqlite3").exists()


def test_embeds_path_plus_text_in_batches(index_root, embedder, monkeypatch):
    monkeypatch.setattr(index, "BATCH_SIZE", 2)
    build_index("demo", make_chunks(5), embedder, root=index_root)
    assert [len(c) for c in embedder.calls] == [2, 2, 1]
    assert embedder.calls[0][0] == "f0.py\ndef func_0(): return 0"


def test_index_persists_across_clients(index_root, embedder):
    build_index("demo", make_chunks(4), embedder, root=index_root)
    assert open_index("demo", root=index_root).count() == 4


def test_collection_remembers_its_source(index_root, embedder):
    build_index("demo", make_chunks(), embedder, source_url="https://github.com/a/demo", root=index_root)
    meta = open_index("demo", root=index_root).metadata
    assert meta["source"] == "https://github.com/a/demo" and meta["repo"] == "demo"


def test_reindexing_replaces_the_old_index(index_root, embedder):
    build_index("demo", make_chunks(5, prefix="old"), embedder, root=index_root)
    build_index("demo", make_chunks(2, prefix="new"), embedder, root=index_root)
    col = open_index("demo", root=index_root)
    assert col.count() == 2
    assert {m["path"] for m in col.get()["metadatas"]} == {"new0.py", "new1.py"}


def test_reindexing_the_same_chunks_does_not_duplicate(index_root, embedder):
    for _ in range(3):
        build_index("demo", make_chunks(3), embedder, root=index_root)
    assert open_index("demo", root=index_root).count() == 3


def test_nothing_to_index_keeps_the_old_index(index_root, embedder):
    build_index("demo", make_chunks(3), embedder, root=index_root)
    with pytest.raises(IndexMissingError, match="Nothing to index"):
        build_index("demo", [], embedder, root=index_root)
    assert open_index("demo", root=index_root).count() == 3


def test_open_missing_index(index_root):
    with pytest.raises(IndexMissingError, match="No index for 'ghost'"):
        open_index("ghost", root=index_root)


def test_open_damaged_index(index_root, embedder):
    build_index("demo", make_chunks(), embedder, root=index_root)
    (index_root / "other").mkdir()
    (index_root / "other" / "chroma.sqlite3").write_bytes(b"")   # sqlite file with no collection
    with pytest.raises(IndexMissingError, match="damaged or empty"):
        open_index("other", root=index_root)


def test_list_indexes_newest_first(index_root, embedder):
    import os
    assert list_indexes(index_root) == []
    build_index("first", make_chunks(1), embedder, root=index_root)
    build_index("second", make_chunks(1), embedder, root=index_root)
    (index_root / "not-an-index").mkdir()
    os.utime(index_root / "first" / "chroma.sqlite3", (1, 1))
    assert list_indexes(index_root) == ["second", "first"]
    os.utime(index_root / "second" / "chroma.sqlite3", (1, 1))
    os.utime(index_root / "first" / "chroma.sqlite3", (2_000_000_000, 2_000_000_000))
    assert list_indexes(index_root) == ["first", "second"]
