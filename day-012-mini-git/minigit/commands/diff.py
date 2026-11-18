"""diff: working tree vs index, or (with --staged) index vs HEAD."""

from __future__ import annotations

import os

from ..diff import Side, file_diff
from ..index import mode_from_stat, read_index
from ..objects import hash_object
from ..output import color_enabled, write
from ..repo import Repository
from ..worktree import is_modified, lstat, read_blob, under
from .status import head_files, staged_changes


def register(sub) -> None:
    p = sub.add_parser("diff", help="show changes as a unified diff")
    p.add_argument("--staged", "--cached", dest="staged", action="store_true",
                   help="compare the index with HEAD instead of the working tree with the index")
    p.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    p.add_argument("paths", nargs="*", metavar="<path>")
    p.set_defaults(func=cmd_diff)


def cmd_diff(args) -> int:
    repo = Repository.discover()
    color = color_enabled(args.color)
    prefixes = [repo.relpath(p) for p in args.paths]
    wanted = (lambda path: any(under(path, p) for p in prefixes)) if prefixes else (lambda path: True)
    index = read_index(repo.index_path)

    def blob(sha: str) -> bytes:
        return repo.objects.read_type(sha, "blob")

    pairs = []
    if args.staged:
        head = head_files(repo)
        for path in staged_changes(head, index):
            if not wanted(path):
                continue
            entry = index.get(path)
            old = Side(path, head[path][0], head[path][1], blob(head[path][1])) if path in head else None
            new = Side(path, entry.mode_str, entry.sha, blob(entry.sha)) if entry else None
            pairs.append((old, new))
    else:
        for entry in index:
            if not wanted(entry.path):
                continue
            st = lstat(repo, entry.path)
            if st is not None and not is_modified(repo, index, entry, st):
                continue
            old = Side(entry.path, entry.mode_str, entry.sha, blob(entry.sha))
            new = None
            if st is not None:
                data = read_blob(repo, entry.path, st)
                new = Side(entry.path, f"{mode_from_stat(st):o}", hash_object(data), data)
            pairs.append((old, new))

    pairs.sort(key=lambda pair: os.fsencode((pair[1] or pair[0]).path))
    write(b"".join(file_diff(old, new, repo.objects.abbreviate, color) for old, new in pairs))
    return 0
