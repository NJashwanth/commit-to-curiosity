"""status: three-way comparison of the HEAD tree, the index and the working tree.

    HEAD tree  --(staged changes)-->  index  --(unstaged changes)-->  working tree
                                                                     + untracked files
"""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass, field

from .. import refs
from ..ignore import IgnoreMatcher
from ..index import Index, read_index
from ..objects import Commit, flatten_tree
from ..output import GREEN, RED, color_enabled, paint, quote_path, write
from ..repo import Repository
from ..worktree import is_modified, lstat, walk

LABELS = {"A": "new file:", "M": "modified:", "D": "deleted:", "T": "typechange:"}


@dataclass
class StatusReport:
    staged: dict[str, str] = field(default_factory=dict)  # path -> A / M / D / T
    unstaged: dict[str, str] = field(default_factory=dict)  # path -> M / D / T
    untracked: list[str] = field(default_factory=list)  # files, or "dir/" for a wholly untracked dir

    @property
    def clean(self) -> bool:
        return not (self.staged or self.unstaged or self.untracked)


def head_files(repo: Repository) -> dict[str, tuple[str, str]]:
    sha = refs.head_commit(repo)
    if sha is None:
        return {}
    return flatten_tree(repo.objects, Commit.parse(repo.objects.read_type(sha, "commit")).tree)


def _kind(mode: str) -> str:
    return "link" if mode == "120000" else "file"


def staged_changes(head: dict, index: Index) -> dict[str, str]:
    changes = {}
    for entry in index:
        old = head.get(entry.path)
        if old is None:
            changes[entry.path] = "A"
        elif _kind(old[0]) != _kind(entry.mode_str):
            changes[entry.path] = "T"
        elif old != (entry.mode_str, entry.sha):
            changes[entry.path] = "M"
    for path in head:
        if path not in index:
            changes[path] = "D"
    return changes


def unstaged_changes(repo: Repository, index: Index) -> dict[str, str]:
    changes = {}
    for entry in index:
        st = lstat(repo, entry.path)
        if st is None:
            changes[entry.path] = "D"
        elif _kind(entry.mode_str) != ("link" if stat.S_ISLNK(st.st_mode) else "file"):
            changes[entry.path] = "T"
        elif is_modified(repo, index, entry, st):
            changes[entry.path] = "M"
    return changes


def untracked_files(repo: Repository, index: Index, ignore: IgnoreMatcher) -> list[str]:
    """Untracked paths; a directory with no tracked files inside is listed once as ``dir/``."""
    tracked_dirs = set()
    for path in index.entries:
        parts = path.split("/")
        tracked_dirs.update("/".join(parts[:i]) for i in range(1, len(parts)))
    found = []

    def visit(rel_dir: str) -> None:
        top = repo.abspath(rel_dir) if rel_dir else repo.root
        for name in os.listdir(top):
            if name == ".git":
                continue
            rel = f"{rel_dir}/{name}" if rel_dir else name
            full = top / name
            if full.is_dir() and not full.is_symlink():
                if ignore.is_ignored(rel, is_dir=True):
                    continue
                if rel in tracked_dirs:
                    visit(rel)
                elif next(walk(repo, ignore, rel), None) is not None:
                    found.append(rel + "/")
            elif rel not in index and lstat(repo, rel) and not ignore.is_ignored(rel):
                found.append(rel)

    visit("")
    return sorted(found, key=os.fsencode)


def compute_status(repo: Repository, index: Index | None = None) -> StatusReport:
    index = index if index is not None else read_index(repo.index_path)
    return StatusReport(
        staged=staged_changes(head_files(repo), index),
        unstaged=unstaged_changes(repo, index),
        untracked=untracked_files(repo, index, IgnoreMatcher(repo.root, repo.gitdir)),
    )


def register(sub) -> None:
    p = sub.add_parser("status", help="show staged, unstaged and untracked changes")
    fmt = p.add_mutually_exclusive_group()
    fmt.add_argument("-s", "--short", action="store_true", help="two-column short format")
    fmt.add_argument("--porcelain", action="store_true", help="stable short format for scripts (no color)")
    p.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    p.set_defaults(func=cmd_status)


def cmd_status(args) -> int:
    repo = Repository.discover()
    report = compute_status(repo)
    if args.short or args.porcelain:
        write(short_format(report, color_enabled(args.color) and not args.porcelain))
    else:
        write(long_format(repo, report, color_enabled(args.color)))
    return 0


def short_format(report: StatusReport, color: bool) -> str:
    lines = []
    for path in sorted(set(report.staged) | set(report.unstaged), key=os.fsencode):
        x, y = report.staged.get(path, " "), report.unstaged.get(path, " ")
        lines.append(f"{paint(x, GREEN, color and x != ' ')}{paint(y, RED, color and y != ' ')} {quote_path(path, True)}\n")
    lines += [f"{paint('??', RED, color)} {quote_path(path, True)}\n" for path in report.untracked]
    return "".join(lines)


def long_format(repo: Repository, report: StatusReport, color: bool) -> str:
    out = []
    branch = refs.current_branch(repo)
    head = refs.head_commit(repo)
    if branch:
        out.append(f"On branch {branch}\n")
    else:
        out.append(paint(f"HEAD detached at {repo.objects.abbreviate(head)}", RED, color) + "\n")
    if head is None:
        out.append("\nNo commits yet\n")

    def rel(path: str) -> str:
        shown = os.path.relpath(repo.abspath(path.rstrip("/")), os.getcwd()).replace(os.sep, "/")
        return quote_path(shown + ("/" if path.endswith("/") else ""))

    def section(title, hints, items, col):
        out.append(f"\n{title}\n")
        out.extend(f"  ({hint})\n" for hint in hints)
        for path, code in items:
            label = f"{LABELS[code]:<12}" if code else ""
            out.append("\t" + paint(label + rel(path), col, color) + "\n")

    if report.staged:
        unstage = "minigit rm --cached <file>..." if head is None else "minigit restore --staged <file>..."
        section("Changes to be committed:", [f'use "{unstage}" to unstage'],
                sorted(report.staged.items(), key=lambda kv: os.fsencode(kv[0])), GREEN)
    if report.unstaged:
        verb = "add/rm" if "D" in report.unstaged.values() else "add"
        section("Changes not staged for commit:",
                [f'use "minigit {verb} <file>..." to update what will be committed',
                 'use "minigit checkout -- <file>..." to discard changes in working directory'],
                sorted(report.unstaged.items(), key=lambda kv: os.fsencode(kv[0])), RED)
    if report.untracked:
        section("Untracked files:", ['use "minigit add <file>..." to include in what will be committed'],
                [(p, None) for p in report.untracked], RED)

    if report.staged:
        out.append("\n")
    elif report.unstaged:
        out.append('\nno changes added to commit (use "minigit add" and/or "minigit commit -a")\n')
    elif report.untracked:
        out.append('\nnothing added to commit but untracked files present (use "minigit add" to track)\n')
    elif head is None:
        out.append('\nnothing to commit (create/copy files and use "minigit add" to track)\n')
    else:
        out.append("nothing to commit, working tree clean\n")
    return "".join(out)
