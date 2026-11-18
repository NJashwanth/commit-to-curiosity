"""add and ls-files."""

from __future__ import annotations

import sys

from ..errors import GitError
from ..ignore import IgnoreMatcher
from ..index import read_index, write_index
from ..output import quote_path, write
from ..repo import Repository
from ..worktree import lstat, stage_file, under, walk


def register(sub) -> None:
    p = sub.add_parser("add", help="stage file contents (respects .gitignore)")
    p.add_argument("-f", "--force", action="store_true", help="allow adding ignored files")
    p.add_argument("-A", "--all", action="store_true", help="stage every change in the repository")
    p.add_argument("paths", nargs="*", metavar="<pathspec>")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("ls-files", help="show the files in the index")
    p.add_argument("-s", "--stage", action="store_true", help="show mode, object id and stage")
    p.set_defaults(func=cmd_ls_files)


def cmd_add(args) -> int:
    repo = Repository.discover()
    specs = list(args.paths)
    if args.all and not specs:
        specs = [str(repo.root)]
    if not specs:
        raise GitError("Nothing specified, nothing added.", code=1, prefix="",
                       notes=["hint: Maybe you wanted to say 'minigit add .'?"])
    index = read_index(repo.index_path)
    ignore = IgnoreMatcher(repo.root, repo.gitdir)
    ignored: list[str] = []

    def stage(rel: str) -> None:
        st = lstat(repo, rel)
        entry = index.get(rel)
        if entry and entry.stat_matches(st) and not index.is_racy(entry):
            return  # unchanged since it was staged
        index.add(stage_file(repo, rel, st))

    resolved = [(spec, repo.relpath(spec)) for spec in specs]
    for spec, rel in resolved:
        full = repo.abspath(rel) if rel else repo.root
        tracked = [p for p in index.entries if under(p, rel)]
        if rel and lstat(repo, rel):  # a single file or symlink
            if ignore.is_ignored(rel) and not args.force and rel not in index:
                ignored.append(rel)
            else:
                stage(rel)
            continue
        if full.is_dir():
            if rel and ignore.is_ignored(rel, is_dir=True) and not args.force and not tracked:
                ignored.append(rel)
                continue
            found = set(walk(repo, ignore, rel))
            for path in sorted(found):
                stage(path)
            for path in tracked:
                # Tracked files stay tracked even if a pattern now ignores them.
                if path not in found and lstat(repo, path):
                    stage(path)
        elif not tracked:
            raise GitError(f"pathspec '{spec}' did not match any files")
        for path in tracked:
            if not lstat(repo, path):
                index.remove(path)  # deleted from disk: stage the removal

    write_index(index, repo.index_path)
    if ignored:
        print("The following paths are ignored by one of your .gitignore files:", file=sys.stderr)
        for path in ignored:
            print(path, file=sys.stderr)
        print("hint: Use -f if you really want to add them.", file=sys.stderr)
        return 1
    return 0


def cmd_ls_files(args) -> int:
    repo = Repository.discover()
    lines = []
    for entry in read_index(repo.index_path):
        name = quote_path(entry.path)
        lines.append(f"{entry.mode_str} {entry.sha} {entry.stage}\t{name}\n" if args.stage else f"{name}\n")
    write("".join(lines))
    return 0
