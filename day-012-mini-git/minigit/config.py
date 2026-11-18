"""Reading Git config files, and working out who the author and committer are."""

from __future__ import annotations

import os
import re
import time
from datetime import datetime
from pathlib import Path

from .errors import GitError
from .objects import Signature

DEFAULT_NAME = "Jashwanth Neela"
DEFAULT_EMAIL = "NJashwanth@users.noreply.github.com"

_SECTION = re.compile(r'^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(?:[#;].*)?$')


def parse_config(text: str) -> dict[str, str]:
    """Flatten a config file to ``{"section.key": value}`` / ``{"section.sub.key": value}``.

    Section and key names are case-insensitive (lowercased); subsections are not.
    Later values win, which is what Git does for single-valued keys.
    """
    values: dict[str, str] = {}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("["):
            m = _SECTION.match(line)
            if not m:
                raise GitError(f"bad config line: {raw}")
            name, sub = m.group(1).lower(), m.group(2)
            if sub is None and "." in name:  # [section.sub] legacy syntax
                name, _, sub = name.partition(".")
            section = name if sub is None else f"{name}.{re.sub(r'\\(.)', r'\1', sub)}"
            continue
        if section is None:
            raise GitError(f"bad config line: {raw}")
        key, eq, value = line.partition("=")
        values[f"{section}.{key.strip().lower()}"] = _parse_value(value) if eq else "true"
    return values


def _parse_value(value: str) -> str:
    out, quoted, i = [], False, 0
    value = value.strip()
    while i < len(value):
        c = value[i]
        if c == '"':
            quoted = not quoted
        elif c == "\\" and i + 1 < len(value):
            i += 1
            out.append({"n": "\n", "t": "\t", "b": "\b"}.get(value[i], value[i]))
        elif c in "#;" and not quoted:
            break
        else:
            out.append(c)
        i += 1
    return "".join(out).rstrip() if not quoted else "".join(out)


def config_files(gitdir: Path | None) -> list[Path]:
    """Lowest precedence first: global (XDG, then ~/.gitconfig), then the repository's."""
    home = Path(os.environ.get("HOME", Path.home()))
    xdg = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
    files = [xdg / "git" / "config", home / ".gitconfig"]
    if gitdir is not None:
        files.append(Path(gitdir) / "config")
    return files


def load_config(gitdir: Path | None = None) -> dict[str, str]:
    merged: dict[str, str] = {}
    for path in config_files(gitdir):
        if path.is_file():
            merged.update(parse_config(path.read_text(encoding="utf-8", errors="surrogateescape")))
    return merged


def parse_date(text: str) -> tuple[int, str]:
    """Accept Git's raw ``<unix> <+hhmm>`` (optionally ``@``-prefixed) or ISO 8601."""
    text = text.strip()
    m = re.fullmatch(r"@?(\d+)(?:\s+([+-]\d{4}))?", text)
    if m:
        return int(m.group(1)), m.group(2) or "+0000"
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise GitError(f"invalid date format: {text}") from None
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return int(dt.timestamp()), format_offset(int(dt.utcoffset().total_seconds()))


def format_offset(seconds: int) -> str:
    sign = "-" if seconds < 0 else "+"
    minutes = abs(seconds) // 60
    return f"{sign}{minutes // 60:02d}{minutes % 60:02d}"


def local_offset(timestamp: int) -> str:
    return format_offset(time.localtime(timestamp).tm_gmtoff)


def identity(role: str, gitdir: Path | None = None, now: int | None = None) -> Signature:
    """The author or committer signature.

    Name and email come from ``GIT_AUTHOR_NAME``/``GIT_COMMITTER_EMAIL`` and friends,
    then ``user.name``/``user.email`` in the repository config, then the global config,
    and finally the built-in default. The date comes from ``GIT_<ROLE>_DATE`` or the
    clock, in the local timezone.
    """
    prefix = f"GIT_{role.upper()}_"
    config = load_config(gitdir)
    name = os.environ.get(prefix + "NAME") or config.get("user.name") or DEFAULT_NAME
    email = os.environ.get(prefix + "EMAIL") or config.get("user.email") or DEFAULT_EMAIL
    if os.environ.get(prefix + "DATE"):
        timestamp, tz = parse_date(os.environ[prefix + "DATE"])
    else:
        timestamp = int(time.time()) if now is None else now
        tz = local_offset(timestamp)
    for value in (name, email):
        if any(c in value for c in "<>\n"):
            raise GitError(f"invalid identity: {value!r} contains '<', '>' or a newline")
    return Signature(name, email, timestamp, tz)
