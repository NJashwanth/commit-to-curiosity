"""Find the chunks most similar to a question."""
from dataclasses import dataclass

TOP_K = 6


@dataclass(frozen=True)
class Hit:
    path: str
    start_line: int
    end_line: int
    text: str
    score: float   # cosine similarity: 1.0 is identical, 0 is unrelated

    @property
    def ref(self):
        """Citation form: path:start-end."""
        return f"{self.path}:{self.start_line}-{self.end_line}"


def retrieve(question, collection, embedder, k=TOP_K):
    """Top-k chunks for the question, most similar first. Empty list for an empty index."""
    total = collection.count()
    if k < 1 or total == 0 or not question.strip():
        return []
    [vector] = embedder.embed([question])
    result = collection.query(
        query_embeddings=[vector], n_results=min(k, total),
        include=["documents", "metadatas", "distances"])
    hits = [
        Hit(meta["path"], meta["start_line"], meta["end_line"], doc, 1.0 - dist)
        for doc, meta, dist in zip(
            result["documents"][0], result["metadatas"][0], result["distances"][0])
    ]
    return sorted(hits, key=lambda h: h.score, reverse=True)
