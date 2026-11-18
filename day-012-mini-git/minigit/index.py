"""The staging area: ``.git/index`` in Git's binary format, version 2.

Layout (all integers big-endian)::

    header   "DIRC" | version (4 bytes) | entry count (4 bytes)
    entries  ctime s/ns, mtime s/ns, dev, ino, mode, uid, gid, size  (10 x 4 bytes)
             SHA-1 (20 bytes) | flags (2 bytes) | path | 1-8 NULs to pad to a multiple of 8
    extensions (optional, skipped and dropped when we rewrite)
    trailer  SHA-1 of everything above

The stat fields let Git skip re-hashing files whose size and timestamps have not
changed, so we record exactly what ``lstat`` reports, truncated to 32 bits like Git.
"""

from __future__ import annotations

import hashlib
import os
import stat
import struct
from dataclasses import dataclass
from pathlib import Path

from .errors import GitError

SIGNATURE = b"DIRC"
ENTRY_HEAD = struct.Struct(">10I20sH")  # 62 bytes before the path
NAME_MASK = 0x0FFF
EXTENDED_FLAG = 0x4000
STAGE_MASK = 0x3000
MASK32 = 0xFFFFFFFF


def mode_from_stat(st: os.stat_result) -> int:
    """Git only tracks three kinds of files: regular, executable and symlink."""
    if stat.S_ISLNK(st.st_mode):
        return 0o120000
    return 0o100755 if st.st_mode & 0o100 else 0o100644


@dataclass
class IndexEntry:
    path: str
    sha: str
    mode: int = 0o100644
    ctime_s: int = 0
    ctime_ns: int = 0
    mtime_s: int = 0
    mtime_ns: int = 0
    dev: int = 0
    ino: int = 0
    uid: int = 0
    gid: int = 0
    size: int = 0
    flags: int = 0  # assume-valid and stage bits; the name length is recomputed on write

    @classmethod
    def from_stat(cls, path: str, sha: str, st: os.stat_result) -> "IndexEntry":
        entry = cls(path, sha, mode_from_stat(st))
        entry.update_stat(st)
        return entry

    def update_stat(self, st: os.stat_result) -> None:
        ctime_s, self.ctime_ns = divmod(st.st_ctime_ns, 1_000_000_000)
        mtime_s, self.mtime_ns = divmod(st.st_mtime_ns, 1_000_000_000)
        self.ctime_s, self.mtime_s = ctime_s & MASK32, mtime_s & MASK32
        self.dev, self.ino = st.st_dev & MASK32, st.st_ino & MASK32
        self.uid, self.gid = st.st_uid & MASK32, st.st_gid & MASK32
        self.size = st.st_size & MASK32

    @property
    def mode_str(self) -> str:
        return f"{self.mode:o}"

    @property
    def stage(self) -> int:
        return (self.flags & STAGE_MASK) >> 12

    def stat_matches(self, st: os.stat_result) -> bool:
        """True when lstat says the file cannot have changed since it was staged."""
        mtime_s, mtime_ns = divmod(st.st_mtime_ns, 1_000_000_000)
        return (
            self.mode == mode_from_stat(st)
            and self.size == st.st_size & MASK32
            and (self.mtime_s, self.mtime_ns) == (mtime_s & MASK32, mtime_ns)
            and self.ino == st.st_ino & MASK32
        )

    def pack(self) -> bytes:
        name = os.fsencode(self.path)
        flags = (self.flags & ~(NAME_MASK | EXTENDED_FLAG)) | min(len(name), NAME_MASK)
        head = ENTRY_HEAD.pack(
            self.ctime_s, self.ctime_ns, self.mtime_s, self.mtime_ns, self.dev, self.ino,
            self.mode, self.uid, self.gid, self.size, bytes.fromhex(self.sha), flags,
        )
        # The entry is padded with 1 to 8 NULs so its length is a multiple of 8.
        length = (ENTRY_HEAD.size + len(name) + 8) & ~7
        return head + name + b"\0" * (length - ENTRY_HEAD.size - len(name))


class Index:
    """Stage-0 entries keyed by path. Paths are repository-relative, '/'-separated."""

    def __init__(self, entries: dict[str, IndexEntry] | None = None, mtime: float | None = None):
        self.entries: dict[str, IndexEntry] = entries or {}
        self.mtime = mtime  # when the index file was last written, for racy-git checks

    def __contains__(self, path: str) -> bool:
        return path in self.entries

    def __iter__(self):
        return iter(self.sorted())

    def __len__(self) -> int:
        return len(self.entries)

    def get(self, path: str) -> IndexEntry | None:
        return self.entries.get(path)

    def add(self, entry: IndexEntry) -> None:
        # A file replaces any directory of the same name, and vice versa.
        prefix = entry.path + "/"
        for other in [p for p in self.entries if p.startswith(prefix)]:
            del self.entries[other]
        parts = entry.path.split("/")
        for i in range(1, len(parts)):
            self.entries.pop("/".join(parts[:i]), None)
        self.entries[entry.path] = entry

    def remove(self, path: str) -> None:
        self.entries.pop(path, None)

    def sorted(self) -> list[IndexEntry]:
        return sorted(self.entries.values(), key=lambda e: os.fsencode(e.path))

    def is_racy(self, entry: IndexEntry) -> bool:
        """A file modified in the same second the index was written can't be trusted by stat."""
        return self.mtime is None or entry.mtime_s >= int(self.mtime)

    # --- serialisation -----------------------------------------------------

    @classmethod
    def parse(cls, data: bytes) -> "Index":
        if len(data) < 32:
            raise GitError("index file is too short")
        body, checksum = data[:-20], data[-20:]
        if checksum != b"\0" * 20 and hashlib.sha1(body).digest() != checksum:
            raise GitError("index file corrupt: bad checksum")
        signature, version, count = struct.unpack(">4sII", body[:12])
        if signature != SIGNATURE:
            raise GitError("index file corrupt: bad signature")
        if version not in (2, 3):
            raise GitError(f"index file version {version} is not supported (only 2 and 3)")
        entries: dict[str, IndexEntry] = {}
        pos = 12
        for _ in range(count):
            fields = ENTRY_HEAD.unpack_from(body, pos)
            flags = fields[11]
            name_start = pos + ENTRY_HEAD.size
            if flags & EXTENDED_FLAG:
                if version < 3:
                    raise GitError("index file corrupt: extended flag in a version 2 index")
                name_start += 2
            name_end = body.index(b"\0", name_start)
            path = os.fsdecode(body[name_start:name_end])
            entry = IndexEntry(
                path, fields[10].hex(), fields[6], *fields[:6], *fields[7:10], flags=flags & ~EXTENDED_FLAG
            )
            if entry.stage:
                raise GitError(f"'{path}' has merge conflicts; resolve them with real git first")
            entries[path] = entry
            pos += (name_end - pos + 8) & ~7
        # Extensions: 4-byte signature, 4-byte size, data. Optional ones start with A-Z.
        while pos < len(body):
            ext, size = struct.unpack_from(">4sI", body, pos)
            if not 65 <= ext[0] <= 90:
                name = ext.decode(errors="replace")
                raise GitError(f"index uses required extension '{name}', which mini-git does not support")
            pos += 8 + size
        return cls(entries)

    def serialize(self) -> bytes:
        entries = self.sorted()
        body = SIGNATURE + struct.pack(">II", 2, len(entries)) + b"".join(e.pack() for e in entries)
        return body + hashlib.sha1(body).digest()


def read_index(path: Path) -> Index:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return Index()
    index = Index.parse(data)
    index.mtime = path.stat().st_mtime
    return index


def write_index(index: Index, path: Path) -> None:
    """Write through ``index.lock`` and rename, the same locking protocol Git uses."""
    lock = path.with_name(path.name + ".lock")
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        raise GitError(
            f"Unable to create '{lock}': File exists.\n\n"
            "Another git process seems to be running in this repository. If not, remove the lock file."
        ) from None
    with os.fdopen(fd, "wb") as fh:
        fh.write(index.serialize())
    os.replace(lock, path)
    index.mtime = path.stat().st_mtime
