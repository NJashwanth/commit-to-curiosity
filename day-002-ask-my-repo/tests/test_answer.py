"""Prompt building, Claude call (client mocked), fallback mode, and citation output."""
import types

import pytest

import answer as ans_mod
from answer import (Answer, answer, ask_claude, build_prompt, cited_refs, fallback_text,
                    format_answer, format_citations)
from retrieval import Hit


def make_hits(n=6):
    return [Hit(f"src/file{i}.py", 10 * i + 1, 10 * i + 9, f"def unique_body_{i}():\n    pass", 0.9 - i / 10)
            for i in range(n)]


class FakeClient:
    """Stands in for anthropic.Anthropic: records the call, returns canned text blocks."""

    def __init__(self, text="The answer is in src/file0.py:1-9.", raises=None, blocks=None):
        self.calls, self.raises = [], raises
        self._blocks = blocks if blocks is not None else [types.SimpleNamespace(text=text)]
        self.messages = types.SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises:
            raise self.raises
        return types.SimpleNamespace(content=self._blocks)


# --- prompt ----------------------------------------------------------------------

def test_prompt_contains_question_and_every_chunk_with_its_path():
    hits = make_hits(6)
    prompt = build_prompt("How does indexing work?", hits)
    assert "Question: How does indexing work?" in prompt
    for hit in hits:
        assert hit.ref in prompt
        assert hit.text in prompt
    assert prompt.count("--- Excerpt") == 6


def test_prompt_sent_to_claude_has_question_chunks_and_instructions(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    client, hits = FakeClient(), make_hits(6)
    ask_claude("Where is the filter?", hits, "key", client=client)
    call = client.calls[0]
    sent = call["messages"][0]
    assert sent["role"] == "user"
    assert "Where is the filter?" in sent["content"]
    assert all(h.ref in sent["content"] and h.text in sent["content"] for h in hits)
    assert "ONLY from those excerpts" in call["system"]
    assert "path:start-end" in call["system"]
    assert call["model"] == ans_mod.DEFAULT_MODEL and call["max_tokens"] == ans_mod.MAX_TOKENS


def test_model_can_be_overridden_from_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
    client = FakeClient()
    ask_claude("q", make_hits(1), "key", client=client)
    assert client.calls[0]["model"] == "claude-sonnet-5-5"


def test_default_client_is_built_from_the_api_key(monkeypatch):
    made = {}

    class Recorder(FakeClient):
        def __init__(self, **kwargs):
            super().__init__()
            made.update(kwargs)

    monkeypatch.setattr("anthropic.Anthropic", Recorder)
    assert ask_claude("q", make_hits(1), "sk-test").startswith("The answer")
    assert made["api_key"] == "sk-test"


def test_text_blocks_are_joined_and_non_text_blocks_ignored():
    blocks = [types.SimpleNamespace(text="Part one. "), types.SimpleNamespace(type="tool_use"),
              types.SimpleNamespace(text="Part two.")]
    assert ask_claude("q", make_hits(1), "k", client=FakeClient(blocks=blocks)) == "Part one. Part two."


# --- answer(): Claude path and fallbacks -------------------------------------------

def test_answer_uses_claude_when_key_is_set():
    client = FakeClient("It lives in src/file0.py:1-9.")
    result = answer("q", make_hits(), api_key="key", client=client)
    assert result.mode == "claude" and result.note == ""
    assert result.text == "It lives in src/file0.py:1-9."
    assert len(client.calls) == 1


@pytest.mark.parametrize("key", [None, "", "   "])
def test_no_api_key_falls_back_without_touching_the_api(key, monkeypatch):
    def boom(**kwargs):
        raise AssertionError("must not create a client without a key")

    monkeypatch.setattr("anthropic.Anthropic", boom)
    result = answer("q", make_hits(), api_key=key)
    assert result.mode == "fallback"
    assert "ANTHROPIC_API_KEY" in result.note
    assert "src/file0.py:1-9" in result.text and "score 0.900" in result.text


def test_claude_failure_falls_back_gracefully():
    client = FakeClient(raises=RuntimeError("503 overloaded"))
    result = answer("q", make_hits(), api_key="key", client=client)
    assert result.mode == "fallback"
    assert "RuntimeError" in result.note and "showing the top matching chunks" in result.note
    assert "src/file0.py:1-9" in result.text


def test_empty_claude_answer_falls_back():
    result = answer("q", make_hits(), api_key="key", client=FakeClient(blocks=[]))
    assert result.mode == "fallback" and "ValueError" in result.note


def test_no_hits_never_calls_claude():
    client = FakeClient()
    result = answer("q", [], api_key="key", client=client)
    assert client.calls == [] and result.text == "No matching code found."


# --- fallback text and citations -----------------------------------------------------

def test_fallback_lists_every_chunk_with_path_and_score():
    text = fallback_text(make_hits(6))
    for i in range(6):
        assert f"src/file{i}.py:{10 * i + 1}-{10 * i + 9}" in text
        assert f"[{i + 1}]" in text
    assert "score 0.900" in text and "score 0.400" in text


def test_fallback_truncates_long_chunks():
    long = Hit("big.py", 1, 100, "\n".join(f"line {i}" for i in range(100)), 0.5)
    text = fallback_text([long])
    assert "line 13" in text and "line 14" not in text
    assert "... (86 more lines)" in text


def test_citations_show_path_range_and_score_for_every_hit():
    out = format_citations(Answer("x", make_hits(3), "fallback"))
    assert out.startswith("Sources:")
    assert "src/file2.py:21-29  score 0.700" in out
    assert "(cited)" not in out   # fallback mode did not cite anything


def test_citations_mark_chunks_the_answer_actually_cited():
    hits = make_hits(3)
    out = format_citations(Answer("See src/file1.py:11-19 for that.", hits, "claude"))
    lines = out.splitlines()
    assert "(cited)" not in lines[1] and "(cited)" in lines[2] and "(cited)" not in lines[3]


def test_cited_refs_does_not_match_longer_numbers():
    hits = [Hit("a.py", 1, 5, "t", 0.5)]
    assert cited_refs("see a.py:1-5", hits) == {"a.py:1-5"}
    assert cited_refs("see a.py:1-50", hits) == set()


def test_no_hits_citation_line():
    assert format_citations(Answer("x", [], "fallback")) == "Sources: none"


def test_format_answer_puts_citations_under_the_text_and_shows_the_note():
    out = format_answer(answer("q", make_hits(2), api_key=None))
    assert out.startswith("Note: No ANTHROPIC_API_KEY set")
    assert out.rstrip().splitlines()[-1].strip().startswith("src/file1.py:11-19")
    assert out.index("Sources:") > out.index("[2]")
    claude = format_answer(answer("q", make_hits(2), api_key="k", client=FakeClient("Yes.")))
    assert claude.startswith("Yes.\n\nSources:")
