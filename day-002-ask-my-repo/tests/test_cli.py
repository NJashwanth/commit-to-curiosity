"""CLI end to end with git, the embedder and the Claude client all mocked."""
import types

import pytest

import ask
import repo
from conftest import FakeEmbedder

URL = "https://github.com/octo/demo"

FILES = {
    "README.md": "# Demo\nA tiny project about sorting numbers.\n",
    "sort.py": "def bubble_sort(items):\n    # sorting numbers with swaps\n    return sorted(items)\n",
    "deploy.sh": "#!/bin/sh\necho deploying the website to production\n",
    "logo.png": b"\x89PNG\0\0",
    "package-lock.json": "{}",
}


@pytest.fixture(autouse=True)
def env(monkeypatch, index_root):
    """Isolated index folder, fake embedder, fake git clone, no real key, no .env file."""
    monkeypatch.setattr(ask, "INDEX_ROOT", index_root)
    monkeypatch.setattr(ask, "Embedder", FakeEmbedder)
    monkeypatch.setattr(ask, "load_dotenv", lambda: None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    cloned = []

    def fake_clone(clone_url, dest):
        cloned.append(clone_url)
        for rel, content in FILES.items():
            path = dest / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content if isinstance(content, bytes) else content.encode())

    monkeypatch.setattr(ask, "clone_repo", fake_clone)
    return types.SimpleNamespace(cloned=cloned)


# --- index ------------------------------------------------------------------------

def test_index_clones_filters_and_stores(env, capsys, index_root):
    assert ask.main(["index", URL]) == 0
    out = capsys.readouterr().out
    assert env.cloned == ["https://github.com/octo/demo.git"]
    assert "Read 3 files" in out           # png and lockfile were skipped
    assert "Indexed 3 chunks" in out
    assert (index_root / "demo" / "chroma.sqlite3").exists()


def test_index_accepts_url_variants(env):
    assert ask.main(["index", URL + ".git"]) == 0
    assert env.cloned == ["https://github.com/octo/demo.git"]


def test_reindex_replaces_the_old_index(env, capsys, index_root):
    ask.main(["index", URL])
    FILES_BACKUP = dict(FILES)
    try:
        FILES.clear()
        FILES["only.txt"] = "the single remaining file\n"
        assert ask.main(["index", URL]) == 0
    finally:
        FILES.clear()
        FILES.update(FILES_BACKUP)
    from index import open_index
    col = open_index("demo", root=index_root)
    assert col.count() == 1 and col.get()["metadatas"][0]["path"] == "only.txt"


def test_index_invalid_url_exits_2_without_cloning(env, capsys):
    assert ask.main(["index", "https://example.com/not-github"]) == 2
    assert "Not a GitHub repo URL" in capsys.readouterr().err
    assert env.cloned == []


def test_index_clone_failure_exits_1(monkeypatch, capsys):
    def failing(clone_url, dest):
        raise repo.RepoError("git clone failed: repository not found")

    monkeypatch.setattr(ask, "clone_repo", failing)
    assert ask.main(["index", URL]) == 1
    assert "repository not found" in capsys.readouterr().err


def test_index_repo_with_nothing_readable(monkeypatch, capsys):
    monkeypatch.setattr(ask, "clone_repo", lambda url, dest: dest.mkdir(parents=True))
    assert ask.main(["index", URL]) == 1
    assert "Nothing to index" in capsys.readouterr().err


# --- ask ---------------------------------------------------------------------------

def test_ask_before_indexing_explains_what_to_do(capsys):
    assert ask.main(["ask", "anything?"]) == 1
    assert "python ask.py index" in capsys.readouterr().err


def test_ask_unknown_repo(capsys):
    assert ask.main(["ask", "q", "--repo", "ghost"]) == 1
    assert "No index for 'ghost'" in capsys.readouterr().err


def test_ask_empty_question(capsys):
    assert ask.main(["ask", "   "]) == 2
    assert "empty" in capsys.readouterr().err


def test_ask_without_key_prints_top_chunks_with_paths_and_scores(capsys):
    ask.main(["index", URL])
    capsys.readouterr()
    assert ask.main(["ask", "bubble_sort sorting numbers swaps"]) == 0
    out = capsys.readouterr().out
    assert "(repo: demo)" in out and "No ANTHROPIC_API_KEY" in out
    assert "sort.py:1-3" in out and "score" in out and "Sources:" in out
    assert out.index("sort.py:1-3") < out.index("deploy.sh:1-2")     # best match listed first


def test_ask_with_key_sends_chunks_to_claude_and_shows_citations(monkeypatch, capsys):
    ask.main(["index", URL])
    capsys.readouterr()
    sent = []

    class FakeAnthropic:
        def __init__(self, **kwargs):
            self.messages = types.SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            sent.append(kwargs)
            return types.SimpleNamespace(content=[types.SimpleNamespace(text="It sorts, see sort.py:1-3.")])

    monkeypatch.setattr("anthropic.Anthropic", FakeAnthropic)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert ask.main(["ask", "how does sorting work?"]) == 0
    out = capsys.readouterr().out
    assert "It sorts, see sort.py:1-3." in out
    assert "sort.py:1-3  score" in out and "(cited)" in out
    assert "how does sorting work?" in sent[0]["messages"][0]["content"]
    assert "deploy.sh:1-2" in sent[0]["messages"][0]["content"]   # all retrieved chunks are sent


def test_ask_k_limits_retrieved_chunks(capsys):
    ask.main(["index", URL])
    capsys.readouterr()
    ask.main(["ask", "sorting", "-k", "1"])
    out = capsys.readouterr().out
    assert out.count("score") == 2   # one in the chunk header, one in Sources


def test_ask_uses_the_most_recent_index_or_the_one_named(env, capsys, monkeypatch):
    import os
    import ask as ask_mod
    ask.main(["index", "https://github.com/octo/older"])
    ask.main(["index", "https://github.com/octo/newer"])
    os.utime(ask_mod.INDEX_ROOT / "older" / "chroma.sqlite3", (1, 1))
    capsys.readouterr()
    ask.main(["ask", "sorting"])
    assert "(repo: newer)" in capsys.readouterr().out
    ask.main(["ask", "sorting", "--repo", "older"])
    assert "(repo: older)" in capsys.readouterr().out


# --- chat ---------------------------------------------------------------------------

def feed(monkeypatch, lines):
    it = iter(lines)

    def fake_input(prompt=""):
        try:
            item = next(it)
        except StopIteration:
            raise EOFError
        if isinstance(item, BaseException):
            raise item
        return item

    monkeypatch.setattr("builtins.input", fake_input)


def test_chat_before_indexing_errors_without_prompting(monkeypatch, capsys):
    feed(monkeypatch, [AssertionError("should not prompt")])
    assert ask.main(["chat"]) == 1
    assert "Nothing indexed yet" in capsys.readouterr().err


@pytest.mark.parametrize("word", ["exit", "quit", ":q", "EXIT"])
def test_chat_exits_on_exit_words(monkeypatch, capsys, word):
    ask.main(["index", URL])
    capsys.readouterr()
    feed(monkeypatch, [word, AssertionError("kept reading after exit")])
    assert ask.main(["chat"]) == 0
    out = capsys.readouterr().out
    assert "Chatting with demo" in out and out.rstrip().endswith("Bye.")


def test_chat_answers_questions_skips_blank_lines_then_exits(monkeypatch, capsys):
    ask.main(["index", URL])
    capsys.readouterr()
    feed(monkeypatch, ["", "  ", "sorting numbers swaps", "deploying the website", "exit"])
    assert ask.main(["chat"]) == 0
    out = capsys.readouterr().out
    assert out.count("Sources:") == 2


def test_chat_ends_cleanly_on_eof_and_ctrl_c(monkeypatch, capsys):
    ask.main(["index", URL])
    capsys.readouterr()
    feed(monkeypatch, [])
    assert ask.main(["chat"]) == 0
    feed(monkeypatch, [KeyboardInterrupt()])
    assert ask.main(["chat"]) == 0
    assert capsys.readouterr().out.count("Bye.") == 2


# --- argument handling -----------------------------------------------------------------

def test_no_command_is_a_usage_error(capsys):
    with pytest.raises(SystemExit) as exc:
        ask.main([])
    assert exc.value.code == 2


def test_ask_requires_a_question():
    with pytest.raises(SystemExit) as exc:
        ask.main(["ask"])
    assert exc.value.code == 2
