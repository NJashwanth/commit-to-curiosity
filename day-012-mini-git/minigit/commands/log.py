"""log: walk the commit graph from a starting point, newest first."""

from __future__ import annotations

import heapq

from .. import refs
from ..errors import GitError
from ..objects import Commit
from ..output import BOLD_CYAN, BOLD_GREEN, RESET, YELLOW, color_enabled, write
from ..repo import Repository

BOLD_YELLOW = "\x1b[1;33m"


def register(sub) -> None:
    p = sub.add_parser("log", help="show commit history")
    p.add_argument("revision", nargs="?", default="HEAD")
    p.add_argument("--oneline", action="store_true", help="one line per commit: short id and subject")
    p.add_argument("-n", "--max-count", type=int, default=None)
    p.add_argument("--no-decorate", action="store_true", help="don't show branch and tag names")
    p.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    p.set_defaults(func=cmd_log)


def walk_commits(repo: Repository, start: str):
    """Yield ``(sha, Commit)`` newest first by committer date, each commit once."""
    seen = {start}
    heap = []
    counter = 0

    def push(sha: str) -> None:
        nonlocal counter
        commit = Commit.parse(repo.objects.read_type(sha, "commit"))
        # Ties keep insertion order, so a linear history is walked child before parent.
        heapq.heappush(heap, (-commit.committer.timestamp, counter, sha, commit))
        counter += 1

    push(start)
    while heap:
        _, _, sha, commit = heapq.heappop(heap)
        yield sha, commit
        for parent in commit.parents:
            if parent not in seen:
                seen.add(parent)
                push(parent)


def decorations(repo: Repository) -> dict[str, list[tuple[str, str]]]:
    """``{sha: [(kind, label), ...]}`` in Git's order: HEAD first, then refs newest name first."""
    by_sha: dict[str, list[tuple[str, str]]] = {}
    names: list[tuple[str, str, str]] = []  # (full refname, kind, label)
    for name, sha in refs.branches(repo).items():
        names.append((f"refs/heads/{name}", "branch", name))
    tags_dir = repo.gitdir / "refs" / "tags"
    tag_refs = {n: s for n, s in refs.packed_refs(repo).items() if n.startswith("refs/tags/")}
    if tags_dir.is_dir():
        for path in tags_dir.rglob("*"):
            if path.is_file():
                tag_refs[f"refs/{path.relative_to(tags_dir.parent).as_posix()}"] = path.read_text().strip()
    for name in tag_refs:
        names.append((name, "tag", f"tag: {name[len('refs/tags/'):]}"))
    branch_shas = refs.branches(repo)
    for refname, kind, label in sorted(names, reverse=True):
        sha = branch_shas.get(label) if kind == "branch" else _peel(repo, tag_refs[refname])
        by_sha.setdefault(sha, []).append((kind, label))

    head = refs.head_commit(repo)
    if head:
        current = refs.current_branch(repo)
        items = by_sha.setdefault(head, [])
        if current:
            items[:] = [i for i in items if i != ("branch", current)]
            items.insert(0, ("head", current))
        else:
            items.insert(0, ("head", None))
    return by_sha


def _peel(repo: Repository, sha: str) -> str:
    """Annotated tags point at a tag object; decorate the commit it points to."""
    obj_type, data = repo.objects.read(sha)
    while obj_type == "tag":
        sha = data.split(b"\n", 1)[0].split()[1].decode()
        obj_type, data = repo.objects.read(sha)
    return sha


def format_decorations(items, color: bool) -> str:
    if not items:
        return ""

    def c(text, code):
        return f"{code}{text}{RESET}" if color else text

    parts = []
    for kind, label in items:
        if kind == "head":
            parts.append(c("HEAD", BOLD_CYAN) + (c(" -> ", YELLOW) + c(label, BOLD_GREEN) if label else ""))
        elif kind == "tag":
            parts.append(c("tag: ", BOLD_YELLOW) + c(label[5:], BOLD_YELLOW))
        else:
            parts.append(c(label, BOLD_GREEN))
    return c(" (", YELLOW) + c(", ", YELLOW).join(parts) + c(")", YELLOW)


def cmd_log(args) -> int:
    repo = Repository.discover()
    color = color_enabled(args.color)
    if args.revision == "HEAD" and refs.head_commit(repo) is None:
        branch = refs.current_branch(repo) or "HEAD"
        raise GitError(f"your current branch '{branch}' does not have any commits yet")
    start = refs.resolve_commit(repo, args.revision)
    decor = {} if args.no_decorate else decorations(repo)

    def yellow(text):
        return f"{YELLOW}{text}{RESET}" if color else text

    chunks = []
    for count, (sha, commit) in enumerate(walk_commits(repo, start)):
        if args.max_count is not None and count >= args.max_count:
            break
        deco = format_decorations(decor.get(sha), color)
        if args.oneline:
            chunks.append(f"{yellow(repo.objects.abbreviate(sha))}{deco} {commit.summary}\n")
            continue
        lines = [f"{yellow('commit ' + sha)}{deco}"]
        if len(commit.parents) > 1:
            lines.append("Merge: " + " ".join(repo.objects.abbreviate(p) for p in commit.parents))
        lines.append(f"Author: {commit.author.name} <{commit.author.email}>")
        lines.append(f"Date:   {commit.author.git_date()}")
        lines.append("")
        lines += [f"    {line}" for line in commit.message.rstrip("\n").split("\n")]
        chunks.append(("\n" if chunks else "") + "\n".join(lines) + "\n")
    write("".join(chunks))
    return 0
