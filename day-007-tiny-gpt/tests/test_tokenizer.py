import pytest

from tokenizer import CharTokenizer


def test_roundtrip():
    text = "Hello, World!\nTo be, or not to be."
    tok = CharTokenizer.from_text(text)
    assert tok.decode(tok.encode(text)) == text


def test_vocab_is_sorted_and_stable():
    tok = CharTokenizer.from_text("banana")
    assert tok.chars == ["a", "b", "n"]
    assert tok.vocab_size == 3
    assert tok.encode("ban") == [1, 0, 2]


def test_unknown_char_strict_raises():
    tok = CharTokenizer.from_text("abc")
    with pytest.raises(ValueError, match="not in vocab"):
        tok.encode("abz")


def test_unknown_char_ignore_drops():
    tok = CharTokenizer.from_text("abc")
    assert tok.encode("azbq c", errors="ignore") == [0, 1, 2]


def test_bad_errors_mode():
    with pytest.raises(ValueError):
        CharTokenizer.from_text("abc").encode("a", errors="replace")


def test_decode_unknown_id_raises():
    tok = CharTokenizer.from_text("abc")
    with pytest.raises(ValueError, match="not in the vocab"):
        tok.decode([0, 99])


def test_duplicate_vocab_rejected():
    with pytest.raises(ValueError):
        CharTokenizer(["a", "a"])


def test_save_load_roundtrip(tmp_path):
    tok = CharTokenizer.from_text("héllo wörld\n")
    path = tmp_path / "sub" / "vocab.json"
    tok.save(path)
    loaded = CharTokenizer.load(path)
    assert loaded.chars == tok.chars
    assert loaded.encode("héllo") == tok.encode("héllo")
    assert tok.to_list() == tok.chars
