from datetime import datetime

import pytest

from errors import ToolError
from files import MAX_NOTE_CHARS, read_file, save_note

NOW = datetime(2026, 11, 7, 14, 5)


def test_creates_notes_file_when_missing(tmp_path):
    assert save_note("buy milk", root=tmp_path, now=NOW) == "Saved note to notes.md."
    assert (tmp_path / "notes.md").read_text(encoding="utf-8") == "- 2026-11-07 14:05: buy milk\n"


def test_appends_without_touching_existing_content(tmp_path):
    (tmp_path / "notes.md").write_text("# Notes\n\n- old\n", encoding="utf-8")
    save_note("new one", root=tmp_path, now=NOW)
    save_note("another", root=tmp_path, now=NOW)
    assert read_file("notes.md", root=tmp_path) == (
        "# Notes\n\n- old\n- 2026-11-07 14:05: new one\n- 2026-11-07 14:05: another\n"
    )


def test_adds_newline_if_file_does_not_end_with_one(tmp_path):
    (tmp_path / "notes.md").write_text("- no trailing newline", encoding="utf-8")
    save_note("x", root=tmp_path, now=NOW)
    assert (tmp_path / "notes.md").read_text(encoding="utf-8") == "- no trailing newline\n- 2026-11-07 14:05: x\n"


def test_multiline_note_is_flattened(tmp_path):
    save_note("line one\n\n  line two", root=tmp_path, now=NOW)
    assert (tmp_path / "notes.md").read_text(encoding="utf-8").count("\n") == 1


def test_uses_current_time_by_default(tmp_path):
    save_note("hi", root=tmp_path)
    assert (tmp_path / "notes.md").read_text(encoding="utf-8").startswith("- 20")


@pytest.mark.parametrize("text", ["", "   \n", None, 7])
def test_empty_or_non_string_rejected(tmp_path, text):
    with pytest.raises(ToolError, match="empty"):
        save_note(text, root=tmp_path)
    assert not (tmp_path / "notes.md").exists()


def test_too_long_rejected(tmp_path):
    with pytest.raises(ToolError, match="too long"):
        save_note("x" * (MAX_NOTE_CHARS + 1), root=tmp_path)


def test_always_writes_to_notes_md_only(tmp_path):
    save_note("../escape.md", root=tmp_path, now=NOW)  # the text is just text, the path is fixed
    assert [p.name for p in tmp_path.iterdir()] == ["notes.md"]
