"""Local embeddings (sentence-transformers) and the persisted Chroma index."""
import sys
from pathlib import Path

MODEL_NAME = "all-MiniLM-L6-v2"
COLLECTION = "chunks"
INDEX_ROOT = Path(__file__).resolve().parent / ".index"
BATCH_SIZE = 64


class IndexMissingError(Exception):
    """Raised when an index is missing or there is nothing to put in one."""


class Embedder:
    """Wraps a local sentence-transformers model. The model loads on first use, not at import."""

    def __init__(self, model_name=MODEL_NAME):
        self.model_name = model_name
        self._model = None

    def _load(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            print(f"Loading embedding model {self.model_name} (first run downloads it)...",
                  file=sys.stderr)
            self._model = SentenceTransformer(self.model_name)
        return self._model

    def embed(self, texts):
        """Unit-length vectors (so dot product == cosine similarity), one list per text."""
        if not texts:
            return []
        vectors = self._load().encode(
            list(texts), batch_size=32, normalize_embeddings=True, show_progress_bar=False)
        return [[float(x) for x in v] for v in vectors]


def chunk_embedding_text(chunk):
    """What gets embedded: the path (file names carry meaning) plus the chunk text."""
    return f"{chunk.path}\n{chunk.text}"


def index_dir(name, root=INDEX_ROOT):
    return Path(root) / name


def _client(name, root):
    import chromadb
    from chromadb.config import Settings
    path = index_dir(name, root)
    path.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(path=str(path), settings=Settings(anonymized_telemetry=False))


def build_index(name, chunks, embedder, source_url="", root=INDEX_ROOT):
    """Replace the index for `name` with `chunks`. Returns the number of chunks stored.

    The old collection is dropped only after we know there is something to put in its place.
    """
    chunks = list(chunks)
    if not chunks:
        raise IndexMissingError("Nothing to index: no readable text files were found.")
    client = _client(name, root)
    try:
        client.delete_collection(COLLECTION)
    except Exception:  # chroma raises different errors by version when it does not exist
        pass
    collection = client.create_collection(
        COLLECTION, embedding_function=None,
        metadata={"hnsw:space": "cosine", "source": source_url, "repo": name})
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i:i + BATCH_SIZE]
        collection.add(
            ids=[c.ref for c in batch],
            documents=[c.text for c in batch],
            embeddings=embedder.embed([chunk_embedding_text(c) for c in batch]),
            metadatas=[{"path": c.path, "start_line": c.start_line, "end_line": c.end_line}
                       for c in batch],
        )
    return collection.count()


def open_index(name, root=INDEX_ROOT):
    """The Chroma collection for an indexed repo, or IndexMissingError if it was never indexed."""
    if not (index_dir(name, root) / "chroma.sqlite3").exists():
        raise IndexMissingError(f"No index for '{name}'. Run: python ask.py index <github-url>")
    try:
        return _client(name, root).get_collection(COLLECTION, embedding_function=None)
    except Exception as exc:
        raise IndexMissingError(f"Index for '{name}' is damaged or empty. Re-run: python ask.py index <github-url>") from exc


def list_indexes(root=INDEX_ROOT):
    """Names of indexed repos, most recently indexed first."""
    root = Path(root)
    if not root.is_dir():
        return []
    found = [p for p in root.iterdir() if (p / "chroma.sqlite3").exists()]
    return [p.name for p in sorted(found, key=lambda p: (p / "chroma.sqlite3").stat().st_mtime, reverse=True)]
