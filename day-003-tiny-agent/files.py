"""Sandboxed list_files, read_file and save_note tools. Everything stays inside workspace/."""
from datetime import datetime
from pathlib import Path, PureWindowsPath

from errors import ToolError

WORKSPACE = Path(__file__).resolve().parent / "workspace"
MAX_READ_CHARS = 20_000
MAX_NOTE_CHARS = 2_000
NOTES_FILE = "notes.md"

LIST_FILES_SCHEMA = {
    "name": "list_files",
    "description": (
        "List the files and folders in the workspace/ sandbox. Folders end with '/'. "
        "Pass a relative sub-folder path, or leave it out for the top level."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Folder relative to workspace/. Defaults to '.'."}
        },
    },
}

READ_FILE_SCHEMA = {
    "name": "read_file",
    "description": "Read a UTF-8 text file from the workspace/ sandbox. The path is relative to workspace/.",
    "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string", "description": "File path relative to workspace/."}},
        "required": ["path"],
    },
}

SAVE_NOTE_SCHEMA = {
    "name": "save_note",
    "description": "Append a short note to workspace/notes.md, stamped with the current date and time.",
    "input_schema": {
        "type": "object",
        "properties": {"text": {"type": "string", "description": "The note to save (one or a few lines)."}},
        "required": ["text"],
    },
}


def resolve_in_workspace(path, root=None):
    """Turn a user-supplied relative path into a real path inside the workspace, or raise ToolError."""
    root = (root or WORKSPACE).resolve()
    if not isinstance(path, str):
        raise ToolError("Path must be a string.")
    if "\x00" in path:
        raise ToolError("Invalid path.")
    raw = path.strip() or "."
    # Check with both path flavours so '/etc/passwd', '\\x' and 'C:\\x' are all rejected on any OS.
    if Path(raw).is_absolute() or PureWindowsPath(raw).is_absolute() or raw.startswith(("/", "\\")) \
            or PureWindowsPath(raw).drive:
        raise ToolError("Absolute paths are not allowed. Use a path relative to workspace/.")
    if ".." in raw.replace("\\", "/").split("/"):
        raise ToolError("Path traversal ('..') is not allowed.")
    target = (root / raw).resolve()
    # resolve() follows symlinks, so a link pointing outside the sandbox is caught here.
    if target != root and root not in target.parents:
        raise ToolError("Path is outside the workspace.")
    return target


def list_files(path=".", root=None):
    """List a workspace folder, one entry per line, folders marked with a trailing '/'."""
    target = resolve_in_workspace(path, root)
    if not target.exists():
        raise ToolError(f"No such folder: {path}")
    if not target.is_dir():
        raise ToolError(f"Not a folder: {path}")
    entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    if not entries:
        return "(empty folder)"
    return "\n".join(p.name + ("/" if p.is_dir() else "") for p in entries)


def read_file(path, root=None):
    """Return the text of a workspace file, truncated if it is very long."""
    target = resolve_in_workspace(path, root)
    if not target.exists():
        raise ToolError(f"No such file: {path}")
    if not target.is_file():
        raise ToolError(f"Not a file: {path}")
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise ToolError(f"{path} is not a UTF-8 text file.") from None
    if len(text) > MAX_READ_CHARS:
        return text[:MAX_READ_CHARS] + f"\n... [truncated, file has {len(text)} characters]"
    return text


def save_note(text, root=None, now=None):
    """Append a timestamped bullet to workspace/notes.md. The file is created if it is missing."""
    if not isinstance(text, str) or not text.strip():
        raise ToolError("Note text cannot be empty.")
    text = " ".join(text.split())  # one line per note keeps the file tidy
    if len(text) > MAX_NOTE_CHARS:
        raise ToolError(f"Note is too long (limit {MAX_NOTE_CHARS} characters).")
    target = resolve_in_workspace(NOTES_FILE, root)
    target.parent.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now()).strftime("%Y-%m-%d %H:%M")
    needs_newline = target.exists() and target.stat().st_size > 0 and not target.read_text(encoding="utf-8").endswith("\n")
    with target.open("a", encoding="utf-8") as fh:
        fh.write(("\n" if needs_newline else "") + f"- {stamp}: {text}\n")
    return f"Saved note to {NOTES_FILE}."
