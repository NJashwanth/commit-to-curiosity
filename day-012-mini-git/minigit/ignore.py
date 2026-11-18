"""``.gitignore`` rules: globs, directory-only patterns, anchoring, ``**`` and negation.

Rules come from ``.git/info/exclude`` and every ``.gitignore`` between the repository
root and the path being checked. The last matching rule wins, and rules in a deeper
``.gitignore`` beat shallower ones. Once a directory is ignored nothing inside it can
be re-included, because Git never looks inside it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Rule:
    pattern: str
    base: str  # directory holding the .gitignore, "" for the root
    negate: bool
    dir_only: bool
    anchored: bool  # contains a slash, so it matches against the full path below base
    regex: re.Pattern

    def matches(self, path: str, is_dir: bool) -> bool:
        if self.dir_only and not is_dir:
            return False
        if self.base:
            if not path.startswith(self.base + "/"):
                return False
            path = path[len(self.base) + 1 :]
        target = path if self.anchored else path.rsplit("/", 1)[-1]
        return self.regex.fullmatch(target) is not None


def glob_to_regex(glob: str) -> str:
    """Translate a gitignore glob into a regex. ``*`` and ``?`` never match ``/``."""
    out = []
    i, n = 0, len(glob)
    while i < n:
        c = glob[i]
        if glob.startswith("**/", i) and (i == 0 or glob[i - 1] == "/"):
            out.append("(?:.*/)?")  # zero or more leading directories
            i += 3
        elif glob.startswith("/**", i) and i + 3 == n:
            out.append("/.*")  # everything inside
            i += 3
        elif c == "*":
            while i < n and glob[i] == "*":
                i += 1
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            end = glob.find("]", i + 2 if glob[i + 1 : i + 2] in ("!", "^", "]") else i + 1)
            if end == -1:
                out.append(re.escape(c))
                i += 1
                continue
            body = glob[i + 1 : end]
            if body[0] in "!^":
                body = "^" + body[1:]
            out.append("[" + body.replace("\\", "\\\\") + "]")
            i = end + 1
        elif c == "\\" and i + 1 < n:
            out.append(re.escape(glob[i + 1]))
            i += 2
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)


def parse_line(line: str, base: str) -> Rule | None:
    line = line.rstrip("\n").rstrip("\r")
    # Trailing spaces are ignored unless escaped with a backslash.
    stripped = line.rstrip(" ")
    if stripped.endswith("\\") and len(stripped) < len(line):
        stripped += " "
    line = stripped
    if not line or line.startswith("#"):
        return None
    negate = line.startswith("!")
    if negate:
        line = line[1:]
    elif line.startswith("\\!") or line.startswith("\\#"):
        line = line[1:]
    dir_only = line.endswith("/")
    line = line.rstrip("/")
    if not line:
        return None
    anchored = "/" in line
    line = line.lstrip("/")
    return Rule(line, base, negate, dir_only, anchored, re.compile(glob_to_regex(line), re.DOTALL))


def parse_rules(text: str, base: str = "") -> list[Rule]:
    return [rule for rule in (parse_line(line, base) for line in text.splitlines()) if rule]


class IgnoreMatcher:
    def __init__(self, root: Path, gitdir: Path | None = None):
        self.root = Path(root)
        self._cache: dict[str, list[Rule]] = {}
        exclude = (gitdir or self.root / ".git") / "info" / "exclude"
        self._base_rules = parse_rules(_read(exclude)) if exclude.is_file() else []

    def rules_for_dir(self, rel_dir: str) -> list[Rule]:
        if rel_dir not in self._cache:
            path = self.root / rel_dir / ".gitignore" if rel_dir else self.root / ".gitignore"
            self._cache[rel_dir] = parse_rules(_read(path), rel_dir) if path.is_file() else []
        return self._cache[rel_dir]

    def _rules(self, path: str) -> list[Rule]:
        """Every rule that could apply to ``path``, lowest precedence first."""
        parts = path.split("/")[:-1]
        rules = list(self._base_rules)
        rules += self.rules_for_dir("")
        for i in range(1, len(parts) + 1):
            rules += self.rules_for_dir("/".join(parts[:i]))
        return rules

    def _match(self, path: str, is_dir: bool) -> bool:
        for rule in reversed(self._rules(path)):
            if rule.matches(path, is_dir):
                return not rule.negate
        return False

    def is_ignored(self, path: str, is_dir: bool = False) -> bool:
        """Is this repository-relative path ignored (directly or via an ignored parent)?"""
        parts = path.split("/")
        for i in range(1, len(parts)):
            if self._match("/".join(parts[:i]), True):
                return True
        return self._match(path, is_dir)


def _read(path: Path) -> str:
    return path.read_bytes().decode("utf-8", "surrogateescape")
