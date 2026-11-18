"""The object store: blobs, trees and commits in Git's exact on-disk format.

Every object is stored as ``zlib(b"<type> <size>\\0" + content)`` at
``.git/objects/<first 2 hex>/<remaining 38 hex>``, and its id is the SHA-1 of the
uncompressed bytes (header included). Get the header or the tree ordering wrong by a
single byte and the ids stop matching real Git, so this module is deliberately strict.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .errors import GitError

OBJECT_TYPES = ("blob", "tree", "commit", "tag")
HEX = set("0123456789abcdef")

# Tree entry modes, as Git writes them (note: no leading zero on directories).
MODE_FILE = "100644"
MODE_EXEC = "100755"
MODE_SYMLINK = "120000"
MODE_TREE = "40000"
MODE_GITLINK = "160000"


def frame(obj_type: str, data: bytes) -> bytes:
    """The bytes that get hashed and compressed: ``<type> <size>\\0<content>``."""
    return f"{obj_type} {len(data)}".encode() + b"\0" + data


def hash_object(data: bytes, obj_type: str = "blob") -> str:
    return hashlib.sha1(frame(obj_type, data)).hexdigest()


def is_hex(text: str) -> bool:
    return bool(text) and set(text) <= HEX


def mode_type(mode: str) -> str:
    """Object type a tree entry's mode points at."""
    if mode == MODE_TREE:
        return "tree"
    if mode == MODE_GITLINK:
        return "commit"
    return "blob"


class ObjectStore:
    """Loose objects under ``.git/objects``."""

    def __init__(self, gitdir: Path):
        self.dir = Path(gitdir) / "objects"

    def path(self, sha: str) -> Path:
        return self.dir / sha[:2] / sha[2:]

    def exists(self, sha: str) -> bool:
        return len(sha) == 40 and self.path(sha).is_file()

    def write(self, obj_type: str, data: bytes) -> str:
        if obj_type not in OBJECT_TYPES:
            raise GitError(f"invalid object type \"{obj_type}\"")
        sha = hash_object(data, obj_type)
        path = self.path(sha)
        if path.exists():
            return sha
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file and rename, so a crash never leaves a half-written object.
        fd, tmp = tempfile.mkstemp(prefix="tmp_obj_", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(zlib.compress(frame(obj_type, data)))
            os.chmod(tmp, 0o444)  # objects are immutable, as in Git
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        return sha

    def read(self, sha: str) -> tuple[str, bytes]:
        path = self.path(sha)
        try:
            compressed = path.read_bytes()
        except (FileNotFoundError, NotADirectoryError):
            raise GitError(f"Not a valid object name {sha}") from None
        try:
            raw = zlib.decompress(compressed)
        except zlib.error:
            raise GitError(f"loose object {sha} (stored in {path}) is corrupt") from None
        header, sep, data = raw.partition(b"\0")
        try:
            type_bytes, size_bytes = header.split(b" ")
            obj_type, size = type_bytes.decode(), int(size_bytes)
        except ValueError:
            raise GitError(f"loose object {sha} has a bad header") from None
        if not sep or obj_type not in OBJECT_TYPES or size != len(data):
            raise GitError(f"loose object {sha} has a bad header")
        return obj_type, data

    def read_type(self, sha: str, expected: str) -> bytes:
        obj_type, data = self.read(sha)
        if obj_type != expected:
            raise GitError(f"object {sha} is a {obj_type}, not a {expected}")
        return data

    def resolve_prefix(self, prefix: str) -> str:
        """Expand an abbreviated id (4 to 40 hex chars) to the one object it names."""
        short = prefix.lower()
        if not (4 <= len(short) <= 40 and is_hex(short)):
            raise GitError(f"Not a valid object name {prefix}")
        if len(short) == 40:
            if self.exists(short):
                return short
            raise GitError(f"Not a valid object name {prefix}")
        bucket = self.dir / short[:2]
        try:
            names = os.listdir(bucket)
        except FileNotFoundError:
            names = []
        matches = sorted(
            short[:2] + name for name in names if len(name) == 38 and (short[:2] + name).startswith(short)
        )
        if not matches:
            raise GitError(f"Not a valid object name {prefix}")
        if len(matches) > 1:
            candidates = [f"hint:   {sha} {self.read(sha)[0]}" for sha in matches]
            raise GitError(
                f"Not a valid object name {prefix}",
                notes=[f"error: short object ID {prefix} is ambiguous", "hint: The candidates are:", *candidates],
            )
        return matches[0]

    def abbreviate(self, sha: str, length: int = 7) -> str:
        """Shortest prefix of at least ``length`` chars that names only this object."""
        bucket = self.dir / sha[:2]
        try:
            others = [sha[:2] + n for n in os.listdir(bucket) if len(n) == 38 and sha[:2] + n != sha]
        except FileNotFoundError:
            others = []
        while length < 40 and any(o.startswith(sha[:length]) for o in others):
            length += 1
        return sha[:length]


# --- trees -----------------------------------------------------------------


@dataclass(frozen=True)
class TreeEntry:
    mode: str
    name: str
    sha: str

    @property
    def is_tree(self) -> bool:
        return self.mode == MODE_TREE

    @property
    def type(self) -> str:
        return mode_type(self.mode)


def tree_sort_key(entry: TreeEntry) -> bytes:
    # Git sorts tree entries by name bytes, but compares a subtree as if its name
    # ended in "/". So "a.txt" < "a/" < "a0" even though "a" < "a.txt" as plain strings.
    return os.fsencode(entry.name) + (b"/" if entry.is_tree else b"")


def serialize_tree(entries) -> bytes:
    out = bytearray()
    for e in sorted(entries, key=tree_sort_key):
        out += f"{e.mode} ".encode() + os.fsencode(e.name) + b"\0" + bytes.fromhex(e.sha)
    return bytes(out)


def parse_tree(data: bytes) -> list[TreeEntry]:
    entries = []
    i = 0
    try:
        while i < len(data):
            space = data.index(b" ", i)
            nul = data.index(b"\0", space)
            raw_sha = data[nul + 1 : nul + 21]
            if len(raw_sha) != 20:
                raise ValueError("truncated")
            entries.append(TreeEntry(data[i:space].decode(), os.fsdecode(data[space + 1 : nul]), raw_sha.hex()))
            i = nul + 21
    except ValueError:
        raise GitError("corrupt tree object") from None
    return entries


# --- commits ---------------------------------------------------------------

_SIGNATURE_RE = re.compile(r"^(.*?) ?<(.*)> (-?\d+) ([+-]\d{4})$")


@dataclass(frozen=True)
class Signature:
    """``Name <email> <unix seconds> <+hhmm>``: who and when, in Git's raw form."""

    name: str
    email: str
    timestamp: int
    tz: str  # e.g. "+0530"

    def format(self) -> str:
        return f"{self.name} <{self.email}> {self.timestamp} {self.tz}"

    @classmethod
    def parse(cls, text: str) -> "Signature":
        m = _SIGNATURE_RE.match(text)
        if not m:
            raise GitError(f"malformed signature: {text!r}")
        return cls(m.group(1), m.group(2), int(m.group(3)), m.group(4))

    @property
    def offset(self) -> timedelta:
        sign = -1 if self.tz[0] == "-" else 1
        return sign * timedelta(hours=int(self.tz[1:3]), minutes=int(self.tz[3:5]))

    def when(self) -> datetime:
        return datetime.fromtimestamp(self.timestamp, timezone(self.offset))

    def git_date(self) -> str:
        """The default date format of ``git log``: ``Tue Nov 14 22:13:20 2023 +0530``."""
        dt = self.when()
        days = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
        months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
        return f"{days[dt.weekday()]} {months[dt.month - 1]} {dt.day} {dt:%H:%M:%S} {dt.year} {self.tz}"


@dataclass
class Commit:
    tree: str
    parents: list[str]
    author: Signature
    committer: Signature
    message: str
    extra: list[tuple[str, str]] = field(default_factory=list)  # e.g. gpgsig, encoding

    def serialize(self) -> bytes:
        lines = [f"tree {self.tree}"]
        lines += [f"parent {p}" for p in self.parents]
        lines.append(f"author {self.author.format()}")
        lines.append(f"committer {self.committer.format()}")
        lines += [f"{key} {value.replace(chr(10), chr(10) + ' ')}" for key, value in self.extra]
        return ("\n".join(lines) + "\n\n" + self.message).encode("utf-8", "surrogateescape")

    @classmethod
    def parse(cls, data: bytes) -> "Commit":
        text = data.decode("utf-8", "surrogateescape")
        head, sep, message = text.partition("\n\n")
        if not sep:
            head, message = text.rstrip("\n"), ""
        headers: list[list[str]] = []
        for line in head.split("\n"):
            if line.startswith(" ") and headers:
                headers[-1][1] += "\n" + line[1:]  # continuation line (gpgsig)
            else:
                key, _, value = line.partition(" ")
                headers.append([key, value])
        tree, parents, author, committer, extra = None, [], None, None, []
        for key, value in headers:
            if key == "tree" and tree is None:
                tree = value
            elif key == "parent":
                parents.append(value)
            elif key == "author" and author is None:
                author = Signature.parse(value)
            elif key == "committer" and committer is None:
                committer = Signature.parse(value)
            else:
                extra.append((key, value))
        if tree is None or author is None or committer is None:
            raise GitError("corrupt commit object")
        return cls(tree, parents, author, committer, message, extra)

    @property
    def summary(self) -> str:
        """First paragraph of the message on one line, like ``%s`` in Git."""
        paragraph = []
        for line in self.message.strip("\n").split("\n"):
            if not line.strip():
                break
            paragraph.append(line.strip())
        return " ".join(paragraph)


def validate(obj_type: str, data: bytes) -> None:
    """Reject trees and commits that real Git would refuse to read."""
    if obj_type == "tree":
        for e in parse_tree(data):
            if not is_hex(e.sha) or not e.mode.isdigit():
                raise GitError("corrupt tree object")
    elif obj_type == "commit":
        Commit.parse(data)
