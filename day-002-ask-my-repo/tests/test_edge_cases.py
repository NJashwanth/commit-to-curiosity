"""Extra edge cases and invariants across the modules."""
import random
import types

import pytest

import answer as ans_mod
import ask
import index
from answer import Answer, ask_claude, build_prompt, format_answer
from chunker import Chunk, chunk_file, chunk_files, estimate_tokens
from conftest import FakeEmbedder
from repo import RepoError, iter_repo_files, parse_repo_url, read_text, should_skip
from retrieval import Hit, retrieve


# --- repo.py ---------------------------------------------------------------------

@pytest.mark.parametrize("url,name", [
    ("https://github.com/vercel/next.js", "next.js"),
    ("https://github.com/a/b.git", "b"),
    ("https://github.com/a/my_repo-2", "my_repo-2"),
    ("http://github.com/A/B", "B"),
])
def test_repo_names_with_dots_dashes_and_case(url, name):
    assert parse_repo_url(url)[1] == name


@pytest.mark.parametrize("url", [
    "https://github.com/a/b?tab=readme", "https://github.com/a/b#frag", "https://github.com/a/b c",
    "https://github.com//b", "ftp://github.com/a/b", "github.com/a/b",
])
def test_more_invalid_or_unsupported_urls(url):
    with pytest.raises(RepoError):
        parse_repo_url(url)


def test_invalid_url_message_shows_expected_form():
    with pytest.raises(RepoError, match=r"https://github.com/<owner>/<repo>"):
        parse_repo_url("nope")


def test_empty_file_reads_as_empty_string(tmp_path):
    f = tmp_path / "empty.txt"
    f.write_bytes(b"")
    assert read_text(f) == ""


def test_utf8_bom_and_emoji_are_readable(tmp_path):
    f = tmp_path / "u.md"
    f.write_text("\ufeff# Héllo 🚀\n", encoding="utf-8")
    assert "🚀" in read_text(f)


def test_nested_ignored_dir_deep_in_the_tree_is_skipped(tmp_path):
    for rel in ("a/b/node_modules/c/d.js", "a/b/keep.py", "a/.git/x", "pkg/dist/y.js"):
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x = 1\n")
    assert [p for p, _ in iter_repo_files(tmp_path)] == ["a/b/keep.py"]


def test_file_at_exactly_the_size_limit_is_indexed(tmp_path):
    (tmp_path / "limit.txt").write_text("a" * (200 * 1024))
    assert [p for p, _ in iter_repo_files(tmp_path)] == ["limit.txt"]


def test_case_insensitive_extension_and_lockfile_matching():
    assert should_skip("Photo.PNG", 1) and should_skip("YARN.LOCK", 1) and should_skip("a/B.MIN.JS", 1)


# --- chunker.py ------------------------------------------------------------------

@pytest.mark.parametrize("path,src,starts", [
    ("a.go", "func A() {}\n\nfunc B() {}\n", [1, 3]),
    ("a.rs", "pub fn a() {}\n\nstruct S;\n\nimpl S {}\n", [1, 3, 5]),
    ("a.ts", "export async function f() {}\n\nexport class C {}\n\ninterface I {}\n", [1, 3, 5]),
    ("a.java", "public class A {\n  void m() {}\n}\n", [1]),
])
def test_boundaries_in_other_languages(path, src, starts):
    assert [c.start_line for c in chunk_file(path, src, min_tokens=1)] == starts


def test_python_nested_defs_stay_inside_their_parent():
    src = "async def a():\n    def inner():\n        pass\n    return inner\n\nclass K:\n    pass\n"
    assert [(c.start_line, c.end_line) for c in chunk_file("a.py", src, min_tokens=1)] == [(1, 5), (6, 7)]


def test_unicode_text_survives_chunking():
    text = "def grüße():\n    return '你好 🚀'\n"
    assert chunk_file("u.py", text)[0].text == text.rstrip("\n")


def test_chunking_is_deterministic():
    text = "\n".join(f"def f{i}():\n    return {i}\n" for i in range(50))
    assert chunk_file("a.py", text) == chunk_file("a.py", text)


def test_only_whitespace_between_defs_does_not_create_empty_chunks():
    src = "def a():\n    pass\n\n\n\n\n\n\ndef b():\n    pass\n"
    assert all(c.text.strip() for c in chunk_file("a.py", src, min_tokens=1))


@pytest.mark.parametrize("seed", range(25))
def test_random_text_invariants(seed):
    """For any input: valid 1-based ranges, in order, text matching its lines, full coverage."""
    rng = random.Random(seed)
    words = ["def f():", "class A:", "    x = 1", "", "# note", "return y", "## Heading", "z" * 90]
    lines = [rng.choice(words) for _ in range(rng.randint(1, 120))]
    text = "\n".join(lines) + rng.choice(["", "\n"])
    chunks = chunk_file(rng.choice(["a.py", "a.md", "a.txt"]), text, max_tokens=60, overlap_tokens=15, min_tokens=10)
    src = text.splitlines()
    covered = set()
    previous_start = 0
    for c in chunks:
        assert 1 <= c.start_line <= c.end_line <= len(src)
        assert c.start_line >= previous_start
        previous_start = c.start_line
        assert c.text == "\n".join(src[c.start_line - 1:c.end_line])
        covered.update(range(c.start_line, c.end_line + 1))
    assert {i + 1 for i, line in enumerate(src) if line.strip()} <= covered


def test_no_chunk_exceeds_the_budget_when_lines_are_short():
    text = "\n".join(f"value_{i} = {i}" for i in range(500))
    for c in chunk_file("a.txt", text, max_tokens=80, overlap_tokens=10):
        assert estimate_tokens(c.text) <= 80 + 8


def test_chunk_files_accepts_a_generator():
    gen = ((f"f{i}.txt", f"text {i}") for i in range(3))
    assert [c.path for c in chunk_files(gen)] == ["f0.txt", "f1.txt", "f2.txt"]


def test_chunks_are_immutable_and_hashable():
    c = Chunk("a", 1, 1, "t")
    with pytest.raises(Exception):
        c.path = "b"
    assert len({c, Chunk("a", 1, 1, "t")}) == 1


# --- index.py --------------------------------------------------------------------

def test_more_chunks_than_one_batch_are_all_stored(index_root):
    chunks = [Chunk(f"f{i}.txt", 1, 1, f"text {i}") for i in range(index.BATCH_SIZE * 2 + 5)]
    assert index.build_index("big", chunks, FakeEmbedder(), root=index_root) == len(chunks)


def test_paths_with_spaces_and_unicode_round_trip(index_root):
    chunks = [Chunk("docs/my file é.md", 2, 4, "héllo wörld 🚀")]
    index.build_index("u", chunks, FakeEmbedder(), root=index_root)
    got = index.open_index("u", root=index_root).get(include=["documents", "metadatas"])
    assert got["documents"] == ["héllo wörld 🚀"] and got["metadatas"][0]["path"] == "docs/my file é.md"


def test_list_indexes_when_root_does_not_exist(tmp_path):
    assert index.list_indexes(tmp_path / "missing") == []


def test_two_repos_do_not_mix(index_root):
    index.build_index("one", [Chunk("one.py", 1, 1, "apple banana")], FakeEmbedder(), root=index_root)
    index.build_index("two", [Chunk("two.py", 1, 1, "cherry date")], FakeEmbedder(), root=index_root)
    hits = retrieve("apple", index.open_index("one", root=index_root), FakeEmbedder())
    assert [h.path for h in hits] == ["one.py"]


# --- retrieval.py ----------------------------------------------------------------

@pytest.mark.parametrize("k", [0, -1, -50])
def test_non_positive_k_returns_nothing_instead_of_crashing(index_root, k):
    index.build_index("x", [Chunk("a.py", 1, 1, "alpha")], FakeEmbedder(), root=index_root)
    assert retrieve("alpha", index.open_index("x", root=index_root), FakeEmbedder(), k=k) == []


def test_identical_chunks_both_come_back_with_equal_scores(index_root):
    chunks = [Chunk("a.py", 1, 1, "same words"), Chunk("b.py", 1, 1, "same words")]
    emb = FakeEmbedder()
    index.build_index("x", chunks, emb, root=index_root)
    hits = retrieve("same words", index.open_index("x", root=index_root), emb)
    assert len(hits) == 2 and hits[0].score == pytest.approx(hits[1].score, abs=1e-4)


def test_question_is_embedded_exactly_once_and_unmodified(index_root):
    emb = FakeEmbedder()
    index.build_index("x", [Chunk("a.py", 1, 1, "alpha")], emb, root=index_root)
    emb.calls.clear()
    retrieve("  What is alpha?  ", index.open_index("x", root=index_root), emb)
    assert emb.calls == [["  What is alpha?  "]]


def test_hit_is_immutable():
    with pytest.raises(Exception):
        Hit("a", 1, 2, "t", 0.5).score = 1.0


# --- answer.py -------------------------------------------------------------------

def hits3():
    return [Hit(f"p{i}.py", i, i + 1, f"body {i}", 0.5) for i in range(1, 4)]


def test_prompt_lists_chunks_in_rank_order_and_ends_with_the_question():
    prompt = build_prompt("Why?", hits3())
    assert prompt.index("p1.py:1-2") < prompt.index("p2.py:2-3") < prompt.index("p3.py:3-4")
    assert prompt.rstrip().endswith("Question: Why?")


def test_prompt_with_multiline_question_is_kept_intact():
    assert "Question: line one\nline two" in build_prompt("line one\nline two", hits3())


def test_empty_model_env_var_uses_the_default(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_MODEL", "")
    calls = []
    client = types.SimpleNamespace(messages=types.SimpleNamespace(
        create=lambda **kw: calls.append(kw) or types.SimpleNamespace(content=[types.SimpleNamespace(text="ok")])))
    ask_claude("q", hits3(), "k", client=client)
    assert calls[0]["model"] == ans_mod.DEFAULT_MODEL


def test_default_client_gets_a_timeout(monkeypatch):
    seen = {}

    class Rec:
        def __init__(self, **kw):
            seen.update(kw)
            self.messages = types.SimpleNamespace(
                create=lambda **k: types.SimpleNamespace(content=[types.SimpleNamespace(text="ok")]))

    monkeypatch.setattr("anthropic.Anthropic", Rec)
    ask_claude("q", hits3(), "key")
    assert seen["timeout"] > 0


@pytest.mark.parametrize("exc", [TimeoutError("slow"), ConnectionError("down"), KeyError("x")])
def test_any_exception_type_from_the_client_falls_back(exc):
    def boom(**kw):
        raise exc

    client = types.SimpleNamespace(messages=types.SimpleNamespace(create=boom))
    result = ans_mod.answer("q", hits3(), api_key="k", client=client)
    assert result.mode == "fallback" and type(exc).__name__ in result.note


def test_whitespace_only_claude_answer_falls_back():
    client = types.SimpleNamespace(messages=types.SimpleNamespace(
        create=lambda **kw: types.SimpleNamespace(content=[types.SimpleNamespace(text="  \n ")])))
    assert ans_mod.answer("q", hits3(), api_key="k", client=client).mode == "fallback"


def test_citation_not_marked_for_a_prefix_range_or_other_file():
    hits = [Hit("a.py", 1, 5, "t", 0.9), Hit("xa.py", 1, 5, "t", 0.8)]
    out = ans_mod.format_citations(Answer("see a.py:1-5", hits, "claude"))
    assert out.count("(cited)") >= 1
    assert ans_mod.cited_refs("see a.py:1-50 and a.py:11-5", hits[:1]) == set()


def test_fallback_preview_keeps_short_chunks_whole():
    text = ans_mod.fallback_text([Hit("a.py", 1, 3, "one\ntwo\nthree", 0.5)])
    assert "more lines" not in text and "    three" in text


def test_format_answer_without_note_has_no_note_line():
    out = format_answer(Answer("plain", hits3(), "claude"))
    assert not out.startswith("Note:") and "plain" in out


# --- ask.py ----------------------------------------------------------------------

@pytest.fixture
def cli_env(monkeypatch, index_root):
    monkeypatch.setattr(ask, "INDEX_ROOT", index_root)
    monkeypatch.setattr(ask, "Embedder", FakeEmbedder)
    monkeypatch.setattr(ask, "load_dotenv", lambda: None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def fake_clone(url, dest):
        dest.mkdir(parents=True)
        (dest / "a.py").write_text("def alpha():\n    return 'alpha beta'\n")

    monkeypatch.setattr(ask, "clone_repo", fake_clone)


@pytest.mark.parametrize("bad", ["0", "-3", "abc", "1.5"])
def test_k_must_be_a_positive_integer(cli_env, bad, capsys):
    with pytest.raises(SystemExit) as exc:
        ask.main(["ask", "q", "-k", bad])
    assert exc.value.code == 2
    assert "-k" in capsys.readouterr().err


def test_chat_also_validates_k(cli_env):
    with pytest.raises(SystemExit) as exc:
        ask.main(["chat", "-k", "0"])
    assert exc.value.code == 2


def test_dotted_repo_name_is_used_as_the_index_folder(cli_env, index_root):
    assert ask.main(["index", "https://github.com/vercel/next.js"]) == 0
    assert (index_root / "next.js" / "chroma.sqlite3").exists()


def test_ask_accepts_non_ascii_questions(cli_env, capsys):
    ask.main(["index", "https://github.com/o/r"])
    capsys.readouterr()
    assert ask.main(["ask", "¿qué hace alpha? 你好"]) == 0
    assert "a.py:1-2" in capsys.readouterr().out


def test_ask_k_larger_than_index_still_works(cli_env, capsys):
    ask.main(["index", "https://github.com/o/r"])
    capsys.readouterr()
    assert ask.main(["ask", "alpha", "-k", "50"]) == 0
    assert capsys.readouterr().out.count("a.py:1-2  score") == 1


def test_chat_survives_a_claude_failure_and_keeps_going(cli_env, monkeypatch, capsys):
    ask.main(["index", "https://github.com/o/r"])
    capsys.readouterr()

    class Broken:
        def __init__(self, **kw):
            def boom(**k):
                raise RuntimeError("503")
            self.messages = types.SimpleNamespace(create=boom)

    monkeypatch.setattr("anthropic.Anthropic", Broken)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    lines = iter(["alpha", "alpha beta", "exit"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(lines))
    assert ask.main(["chat"]) == 0
    out = capsys.readouterr().out
    assert out.count("Claude request failed (RuntimeError)") == 2 and out.count("Sources:") == 2


def test_chat_loads_the_embedder_once_for_many_questions(cli_env, monkeypatch):
    ask.main(["index", "https://github.com/o/r"])
    created = []

    class Counting(FakeEmbedder):
        def __init__(self):
            super().__init__()
            created.append(self)

    monkeypatch.setattr(ask, "Embedder", Counting)
    lines = iter(["alpha", "beta", "gamma", "exit"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(lines))
    ask.main(["chat"])
    assert len(created) == 1 and len(created[0].calls) == 3


def test_reading_dotenv_happens_before_arguments_are_used(monkeypatch, cli_env):
    called = []
    monkeypatch.setattr(ask, "load_dotenv", lambda: called.append(True))
    ask.main(["ask", "q"])
    assert called == [True]
