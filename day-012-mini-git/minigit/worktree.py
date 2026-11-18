"""Reading the working tree: hashing files, walking directories, spotting changes."""

from __future__ import annotations

import os
import stat
from typing import Iterator

from .ignore import IgnoreMatcher
from .index import Index, IndexEntry, mode_from_stat
from .objects import hash_object
from .repo import Repository


def lstat(repo: Repository, rel: str) -> os.stat_result | None:
    try:
        st = os.lstat(repo.abspath(rel))
    except (FileNotFoundError, NotADirectoryError):
        return None
    if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
        return st
    return None  # a directory (or socket, fifo...) where a file should be


def read_blob(repo: Repository, rel: str, st: os.stat_result) -> bytes:
    """The blob content Git stores for a path: file bytes, or a symlink's target."""
    path = repo.abspath(rel)
    if stat.S_ISLNK(st.st_mode):
        return os.fsencode(os.readlink(path))
    return path.read_bytes()


def stage_file(repo: Repository, rel: str, st: os.stat_result) -> IndexEntry:
    """Write the file's blob and return a fresh index entry for it."""
    sha = repo.objects.write("blob", read_blob(repo, rel, st))
    return IndexEntry.from_stat(rel, sha, st)


def file_sha(repo: Repository, rel: str, st: os.stat_result) -> str:
    return hash_object(read_blob(repo, rel, st))


def is_modified(repo: Repository, index: Index, entry: IndexEntry, st: os.stat_result) -> bool:
    """Does the working copy differ from what is staged (content or mode)?"""
    if entry.mode != mode_from_stat(st):
        return True
    if entry.stat_matches(st) and not index.is_racy(entry):
        return False  # stat is unchanged and trustworthy: no need to hash
    if entry.size != st.st_size and not stat.S_ISLNK(st.st_mode):
        return True
    return file_sha(repo, entry.path, st) != entry.sha


def walk(repo: Repository, ignore: IgnoreMatcher, start: str = "") -> Iterator[str]:
    """Yield every non-ignored file under ``start`` (repository-relative), skipping .git."""
    top = repo.abspath(start) if start else repo.root
    try:
        names = sorted(os.listdir(top))
    except (FileNotFoundError, NotADirectoryError):
        return
    for name in names:
        if name == ".git":
            continue
        rel = f"{start}/{name}" if start else name
        full = top / name
        if full.is_dir() and not full.is_symlink():
            if not ignore.is_ignored(rel, is_dir=True):
                yield from walk(repo, ignore, rel)
        elif lstat(repo, rel) and not ignore.is_ignored(rel):
            yield rel


def under(path: str, prefix: str) -> bool:
    """Is ``path`` equal to or inside the repository-relative ``prefix``? ('' is the root.)"""
    return not prefix or path == prefix or path.startswith(prefix + "/")
