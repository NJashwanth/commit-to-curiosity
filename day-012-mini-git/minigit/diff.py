"""Unified diffs in Git's format: ``diff --git`` headers, ``index`` lines, hunks.

Hunks come from :class:`difflib.SequenceMatcher` with 3 lines of context. Git uses
Myers' algorithm, so on tangled edits the two can choose different (equally valid)
hunks; for ordinary edits the output is identical, and every patch applies with
``git apply``.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass

from .output import BOLD, CYAN, GREEN, RED, RESET, quote_path

NULL_SHA = "0" * 40
CONTEXT = 3
FUNCNAME_MAX = 80


@dataclass
class Side:
    """One side of a file diff. ``None`` instead of a Side means the file is absent."""

    path: str
    mode: str  # "100644", "100755", "120000"
    sha: str
    data: bytes


def is_binary(data: bytes) -> bool:
    return b"\0" in data[:8000]  # the same heuristic Git uses


def _range(start: int, length: int) -> str:
    if length == 1:
        return str(start + 1)
    return f"{start + 1 if length else start},{length}"


def _funcname(lines: list[bytes], before: int) -> bytes:
    """Git's default hunk-header context: the nearest earlier line starting with a letter, _ or $."""
    for i in range(before - 1, -1, -1):
        line = lines[i]
        if line[:1].isalpha() or line[:1] in (b"_", b"$"):
            return line[:FUNCNAME_MAX].rstrip()
    return b""


def hunks(old: bytes, new: bytes):
    """Yield ``(header, funcname, [(tag, line), ...])`` per hunk.

    ``tag`` is one of ``" -+"`` and each line keeps its newline (if it had one).
    """
    a, b = old.splitlines(keepends=True), new.splitlines(keepends=True)
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for group in matcher.get_grouped_opcodes(CONTEXT):
        i1, i2, j1, j2 = group[0][1], group[-1][2], group[0][3], group[-1][4]
        header = f"@@ -{_range(i1, i2 - i1)} +{_range(j1, j2 - j1)} @@".encode()
        body = []
        for tag, a1, a2, b1, b2 in group:
            if tag == "equal":
                body += [(" ", line) for line in a[a1:a2]]
                continue
            body += [("-", line) for line in a[a1:a2]]
            body += [("+", line) for line in b[b1:b2]]
        yield header, _funcname(a, i1), body


def _q(prefix: str, path: str) -> bytes:
    return quote_path(prefix + path).encode("utf-8", "surrogateescape")


def file_diff(old: Side | None, new: Side | None, abbrev, color: bool = False) -> bytes:
    """A complete ``diff --git`` section for one path. ``abbrev`` shortens object ids."""
    path = (new or old).path

    def paint(line: bytes, code: str) -> bytes:
        return code.encode() + line + RESET.encode() if color else line

    meta = []
    meta.append(b"diff --git " + _q("a/", path) + b" " + _q("b/", path))
    if old and new and old.mode != new.mode:
        meta += [f"old mode {old.mode}".encode(), f"new mode {new.mode}".encode()]
    elif not old:
        meta.append(f"new file mode {new.mode}".encode())
    elif not new:
        meta.append(f"deleted file mode {old.mode}".encode())

    old_sha, new_sha = (old.sha if old else NULL_SHA), (new.sha if new else NULL_SHA)
    out = [paint(line, BOLD) + b"\n" for line in meta]
    if old_sha == new_sha:
        return b"".join(out)  # mode-only change
    index_line = f"index {abbrev(old_sha)}..{abbrev(new_sha)}"
    if old and new and old.mode == new.mode:
        index_line += f" {old.mode}"
    out.append(paint(index_line.encode(), BOLD) + b"\n")

    old_data, new_data = (old.data if old else b""), (new.data if new else b"")
    a_name = _q("a/", path) if old else b"/dev/null"
    b_name = _q("b/", path) if new else b"/dev/null"
    if is_binary(old_data) or is_binary(new_data):
        out.append(b"Binary files " + a_name + b" and " + b_name + b" differ\n")
        return b"".join(out)

    body = []
    for header, func, lines in hunks(old_data, new_data):
        body.append(paint(header, CYAN) + (b" " + func if func else b"") + b"\n")
        for tag, line in lines:
            content = line.rstrip(b"\n")
            if not color:
                body.append(tag.encode() + content + b"\n")
            elif tag == "-":
                body.append(paint(b"-" + content, RED) + b"\n")
            elif tag == "+":
                # Git paints the sign and the text separately (for whitespace-error highlighting).
                body.append(paint(b"+", GREEN) + (paint(content, GREEN) if content else b"") + b"\n")
            else:
                body.append(b" " + content + RESET.encode() + b"\n")
            if not line.endswith(b"\n"):
                body.append(b"\\ No newline at end of file\n")
    if body:
        # A name containing a space gets a trailing tab, so `patch` knows where it ends.
        out.append(paint(b"--- " + a_name + (b"\t" if b" " in a_name else b""), BOLD) + b"\n")
        out.append(paint(b"+++ " + b_name + (b"\t" if b" " in b_name else b""), BOLD) + b"\n")
        out += body
    return b"".join(out)
