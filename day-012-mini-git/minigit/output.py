"""Writing to stdout as bytes, ANSI colors, and Git's C-style path quoting."""

from __future__ import annotations

import os
import sys

RESET = "\x1b[m"
BOLD = "\x1b[1m"
RED = "\x1b[31m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
CYAN = "\x1b[36m"
BOLD_CYAN = "\x1b[1;36m"
BOLD_GREEN = "\x1b[1;32m"
BOLD_RED = "\x1b[1;31m"


def write(data: bytes | str) -> None:
    """Write text or raw bytes to stdout without mixing up their order."""
    if isinstance(data, str):
        data = data.encode("utf-8", "surrogateescape")
    sys.stdout.flush()
    sys.stdout.buffer.write(data)


def color_enabled(mode: str = "auto") -> bool:
    if mode == "always":
        return True
    if mode == "never":
        return False
    if os.environ.get("NO_COLOR") or os.environ.get("TERM") == "dumb":
        return False
    return sys.stdout.isatty()


def paint(text: str, color: str, enabled: bool) -> str:
    return f"{color}{text}{RESET}" if enabled and text else text


_ESCAPES = {7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 0x22: '"', 0x5C: "\\"}


def quote_path(path: str, quote_space: bool = False) -> str:
    """Quote a path the way Git does with core.quotePath=true (the default).

    Paths made only of printable ASCII come back unchanged. Anything else is wrapped
    in double quotes with C escapes, and every byte >= 0x80 becomes an octal escape,
    so ``café.txt`` prints as ``"caf\\303\\251.txt"``. Short and porcelain status
    output also quote paths containing a space (``quote_space=True``).
    """
    raw = os.fsencode(path)
    special = (0x22, 0x5C, 0x20) if quote_space else (0x22, 0x5C)
    if not any(b < 0x20 or b in special or b >= 0x7F for b in raw):
        return path
    parts = ['"']
    for b in raw:
        if b in _ESCAPES:
            parts.append("\\" + _ESCAPES[b])
        elif b < 0x20 or b >= 0x7F:
            parts.append(f"\\{b:03o}")
        else:
            parts.append(chr(b))
    parts.append('"')
    return "".join(parts)
