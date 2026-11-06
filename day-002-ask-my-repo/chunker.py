"""Split files into chunks, keeping the file path and line range of each one.

Strategy: cut a file at function/class (or markdown heading) boundaries, merge tiny
neighbours so no chunk is trivially small, and fall back to overlapping line windows when
one unit is bigger than the token budget. Tokens are estimated as characters / 4.
"""
import ast
import re
from dataclasses import dataclass

MAX_TOKENS = 800
OVERLAP_TOKENS = 100
MIN_TOKENS = 60

# A new top-level unit starts at a line matching this (column 0 only, so methods stay with their class).
BOUNDARY = re.compile(
    r"^(?:(?:export|default|async|public|private|protected|static|final|abstract|pub|unsafe|extern)\s+)*"
    r"(?:def|class|function|func|fn|interface|struct|enum|trait|impl)\b"
    r"|^[A-Za-z_][\w-]*\s*\(\)\s*\{"   # shell functions: name() {
)
HEADING = re.compile(r"^#{1,6}\s+\S")
MARKDOWN_SUFFIXES = (".md", ".markdown", ".mdx")


@dataclass(frozen=True)
class Chunk:
    path: str
    start_line: int   # 1-based, inclusive
    end_line: int     # 1-based, inclusive
    text: str

    @property
    def ref(self):
        """Citation form: path:start-end."""
        return f"{self.path}:{self.start_line}-{self.end_line}"


def estimate_tokens(text):
    return (len(text) + 3) // 4


def python_boundaries(text):
    """0-based line indexes where a top-level def/class (with its decorators) starts."""
    tree = ast.parse(text)
    starts = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            first = min([node.lineno] + [d.lineno for d in node.decorator_list])
            starts.append(first - 1)
    return starts


def regex_boundaries(path, lines):
    pattern = HEADING if path.lower().endswith(MARKDOWN_SUFFIXES) else BOUNDARY
    return [i for i, line in enumerate(lines) if pattern.match(line)]


def find_boundaries(path, text, lines):
    if path.endswith(".py"):
        try:
            return python_boundaries(text)
        except (SyntaxError, ValueError):
            pass
    return regex_boundaries(path, lines)


def split_into_units(lines, boundaries):
    """Cut lines into (start, end) index ranges (end exclusive) at the given boundaries."""
    cuts = sorted({0, *boundaries, len(lines)})
    return list(zip(cuts, cuts[1:]))


def explode_long_lines(lines, start, end, max_chars):
    """(line_index, piece) pairs for lines[start:end]; over-long lines are cut into pieces."""
    pieces = []
    for i in range(start, end):
        line = lines[i]
        if len(line) <= max_chars:
            pieces.append((i, line))
        else:
            pieces.extend((i, line[k:k + max_chars]) for k in range(0, len(line), max_chars))
    return pieces


def join_pieces(pieces):
    out = []
    for n, (idx, piece) in enumerate(pieces):
        if n and idx != pieces[n - 1][0]:
            out.append("\n")
        out.append(piece)
    return "".join(out)


def window_unit(lines, start, end, max_tokens, overlap_tokens):
    """Split one oversized unit into overlapping windows. Yields (start, end_exclusive, text)."""
    pieces = explode_long_lines(lines, start, end, max_tokens * 4)
    cost = [estimate_tokens(p) + 1 for _, p in pieces]
    i = 0
    while i < len(pieces):
        j, used = i, 0
        while j < len(pieces) and (used + cost[j] <= max_tokens or j == i):
            used += cost[j]
            j += 1
        window = pieces[i:j]
        yield window[0][0], window[-1][0] + 1, join_pieces(window)
        if j >= len(pieces):
            break
        # Step back far enough to share about overlap_tokens, but always move forward.
        back, k = 0, j
        while k > i + 1 and back + cost[k - 1] <= overlap_tokens:
            k -= 1
            back += cost[k]
        i = max(k, i + 1)


def chunk_file(path, text, max_tokens=MAX_TOKENS, overlap_tokens=OVERLAP_TOKENS, min_tokens=MIN_TOKENS):
    """Chunks for one file. Empty or whitespace-only files give no chunks."""
    if not text.strip():
        return []
    lines = text.splitlines()
    units = split_into_units(lines, find_boundaries(path, text, lines))

    chunks, pending = [], None   # pending: [start, end) of small units being merged

    def emit(start, end):
        body = "\n".join(lines[start:end])
        if not body.strip():
            return
        if estimate_tokens(body) <= max_tokens:
            chunks.append(Chunk(path, start + 1, end, body))
            return
        for w_start, w_end, w_text in window_unit(lines, start, end, max_tokens, overlap_tokens):
            chunks.append(Chunk(path, w_start + 1, w_end, w_text))

    def flush():
        nonlocal pending
        if pending:
            emit(*pending)
            pending = None

    for start, end in units:
        size = estimate_tokens("\n".join(lines[start:end]))
        if pending:
            merged = estimate_tokens("\n".join(lines[pending[0]:end]))
            if merged <= max_tokens and estimate_tokens("\n".join(lines[pending[0]:pending[1]])) < min_tokens:
                pending[1] = end
                continue
            flush()
        pending = [start, end]
        if size > max_tokens:
            flush()
    flush()
    return chunks


def chunk_files(files, **kwargs):
    """Chunk every (path, text) pair from repo.iter_repo_files."""
    chunks = []
    for path, text in files:
        chunks.extend(chunk_file(path, text, **kwargs))
    return chunks
