"""Chunker: path and line metadata, boundaries, overlap, and edge cases."""
import pytest

from chunker import Chunk, chunk_file, chunk_files, estimate_tokens


def lines_of(text, chunk):
    """What the chunk's line range says the text should be."""
    return "\n".join(text.splitlines()[chunk.start_line - 1:chunk.end_line])


# --- edge cases ---------------------------------------------------------------

@pytest.mark.parametrize("text", ["", "\n", "   \n\t\n  ", "\n\n\n"])
def test_empty_and_blank_files_give_no_chunks(text):
    assert chunk_file("a.py", text) == []


def test_single_line_file():
    chunks = chunk_file("one.txt", "just one line")
    assert chunks == [Chunk("one.txt", 1, 1, "just one line")]


def test_single_line_with_trailing_newline():
    chunks = chunk_file("one.txt", "just one line\n")
    assert [(c.start_line, c.end_line) for c in chunks] == [(1, 1)]


def test_ref_is_path_colon_range():
    assert Chunk("src/a.py", 3, 9, "x").ref == "src/a.py:3-9"


def test_small_file_is_one_chunk_covering_everything():
    text = "line1\nline2\nline3\n"
    chunks = chunk_file("notes.txt", text)
    assert len(chunks) == 1
    assert (chunks[0].path, chunks[0].start_line, chunks[0].end_line) == ("notes.txt", 1, 3)
    assert chunks[0].text == "line1\nline2\nline3"


def test_windows_line_endings():
    chunks = chunk_file("a.txt", "a\r\nb\r\nc\r\n")
    assert (chunks[0].start_line, chunks[0].end_line) == (1, 3)


# --- function/class boundaries ------------------------------------------------

PY = '''"""Module docstring."""
import os


def alpha():
    return "a" * 100


@decorator
def beta():
    return "b" * 100


class Gamma:
    def method(self):
        return "g" * 100

    def other(self):
        return 1
'''


def test_python_splits_at_top_level_defs_and_classes():
    chunks = chunk_file("m.py", PY, min_tokens=1)
    starts = [c.start_line for c in chunks]
    assert starts == [1, 5, 9, 14]
    assert chunks[1].text.startswith("def alpha")
    assert chunks[2].text.startswith("@decorator")      # decorator stays with its function
    assert chunks[3].text.startswith("class Gamma")
    assert "def other" in chunks[3].text                # methods stay inside their class


def test_python_chunk_ranges_match_the_source_lines():
    for c in chunk_file("m.py", PY, min_tokens=1):
        assert c.text.strip() == lines_of(PY, c).strip()


def test_tiny_units_are_merged_up_to_min_tokens():
    chunks = chunk_file("m.py", PY)   # default min_tokens=60 swallows these small defs
    assert len(chunks) < 4
    assert chunks[0].start_line == 1 and chunks[-1].end_line == len(PY.splitlines())


def test_python_syntax_error_falls_back_to_regex_boundaries():
    broken = "def ok():\n    return 1\n\ndef broken(:\n    pass\n"
    chunks = chunk_file("b.py", broken, min_tokens=1)
    assert [c.start_line for c in chunks] == [1, 4]


def test_markdown_splits_at_headings():
    md = "# Title\nintro\n\n## One\nbody one\n\n## Two\nbody two\n"
    chunks = chunk_file("README.md", md, min_tokens=1)
    assert [(c.start_line, c.end_line) for c in chunks] == [(1, 3), (4, 6), (7, 8)]


def test_javascript_and_shell_functions_are_boundaries():
    js = "export function a() {\n  return 1;\n}\n\nclass B {\n  m() {}\n}\n"
    assert [c.start_line for c in chunk_file("x.js", js, min_tokens=1)] == [1, 5]
    sh = "#!/bin/sh\nset -e\n\nbuild() {\n  make\n}\n\ndeploy() {\n  ./go\n}\n"
    assert [c.start_line for c in chunk_file("x.sh", sh, min_tokens=1)] == [1, 4, 8]


def test_leading_comment_block_before_first_def_is_its_own_chunk():
    chunks = chunk_file("m.py", "# header\n# more\n\ndef f():\n    pass\n", min_tokens=1)
    assert [(c.start_line, c.end_line) for c in chunks] == [(1, 3), (4, 5)]


# --- windows and overlap ------------------------------------------------------

def numbered(n, width=36):
    return "\n".join(f"line {i:04d} " + "x" * width for i in range(1, n + 1)) + "\n"


def test_long_file_without_boundaries_is_windowed_within_budget():
    text = numbered(200)
    chunks = chunk_file("big.txt", text, max_tokens=100, overlap_tokens=20)
    assert len(chunks) > 3
    assert all(estimate_tokens(c.text) <= 100 + 12 for c in chunks)
    for c in chunks:
        assert c.path == "big.txt"
        assert c.text == lines_of(text, c)


def test_windows_overlap_and_cover_every_line_in_order():
    text = numbered(200)
    chunks = chunk_file("big.txt", text, max_tokens=100, overlap_tokens=20)
    covered = set()
    for prev, nxt in zip(chunks, chunks[1:]):
        assert nxt.start_line > prev.start_line                 # always moves forward
        assert nxt.start_line <= prev.end_line                  # overlap: shares at least one line
        assert nxt.start_line > prev.start_line and nxt.end_line > prev.end_line
    for c in chunks:
        covered.update(range(c.start_line, c.end_line + 1))
    assert covered == set(range(1, 201))
    assert chunks[0].start_line == 1 and chunks[-1].end_line == 200


def test_overlap_size_is_roughly_the_requested_tokens():
    text = numbered(200)   # each line is about 12 tokens
    chunks = chunk_file("big.txt", text, max_tokens=100, overlap_tokens=36)
    shared = chunks[0].end_line - chunks[1].start_line + 1
    assert 2 <= shared <= 4


def test_zero_overlap_gives_adjacent_windows():
    text = numbered(100)
    chunks = chunk_file("big.txt", text, max_tokens=100, overlap_tokens=0)
    for prev, nxt in zip(chunks, chunks[1:]):
        assert nxt.start_line == prev.end_line + 1


def test_oversized_function_is_windowed_but_stays_in_its_own_range():
    body = "\n".join(f"    x{i} = {i}  # " + "y" * 30 for i in range(150))
    src = "def small():\n    pass\n\n\ndef huge():\n" + body + "\n"
    chunks = chunk_file("m.py", src, max_tokens=100, overlap_tokens=10, min_tokens=1)
    assert chunks[0].text.startswith("def small")
    huge = [c for c in chunks if c.start_line >= 5]
    assert len(huge) > 2 and huge[0].start_line == 5
    assert huge[-1].end_line == len(src.splitlines())


def test_one_enormous_line_is_split_and_keeps_its_line_number():
    text = "short\n" + "z" * 5000 + "\nlast\n"
    chunks = chunk_file("min.txt", text, max_tokens=100, overlap_tokens=10)
    assert len(chunks) > 2
    assert all(1 <= c.start_line <= c.end_line <= 3 for c in chunks)
    assert any(c.start_line == c.end_line == 2 for c in chunks)
    assert sum(c.text.count("z") for c in chunks) >= 5000   # nothing lost


def test_window_progress_when_overlap_is_larger_than_window():
    chunks = chunk_file("big.txt", numbered(40), max_tokens=30, overlap_tokens=500)
    assert chunks[-1].end_line == 40
    assert len(chunks) < 200   # terminates


# --- whole repo ----------------------------------------------------------------

def test_chunk_files_flattens_and_keeps_paths():
    chunks = chunk_files([("a.txt", "hello"), ("empty.txt", ""), ("b.txt", "x\ny")])
    assert [(c.path, c.start_line, c.end_line) for c in chunks] == [("a.txt", 1, 1), ("b.txt", 1, 2)]


# --- regressions --------------------------------------------------------------

def test_hash_comments_in_shell_are_not_headings():
    sh = "# one\n# two\necho hi\n# three\necho bye\n"
    assert len(chunk_file("run.sh", sh, min_tokens=1)) == 1


def test_prose_starting_with_type_or_string_is_not_a_boundary():
    txt = "string theory\ntype of thing\nint the middle\n"
    assert len(chunk_file("notes.txt", txt, min_tokens=1)) == 1


def test_blank_preamble_before_a_large_first_def_is_dropped():
    src = "\n\n" + "def big():\n" + "".join(f"    v{i} = {i}\n" for i in range(60))
    chunks = chunk_file("m.py", src, max_tokens=50, overlap_tokens=5, min_tokens=1)
    assert chunks[0].start_line == 3
    assert all(c.text.strip() for c in chunks)
