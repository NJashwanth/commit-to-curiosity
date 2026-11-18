"""write-tree, commit and rev-parse."""

from __future__ import annotations

from pathlib import Path

from .. import refs
from ..config import identity
from ..errors import GitError
from ..index import read_index, write_index
from ..objects import Commit, write_tree
from ..output import write
from ..repo import Repository
from ..worktree import is_modified, lstat, stage_file


def register(sub) -> None:
    p = sub.add_parser("write-tree", help="write the index as a tree object")
    p.set_defaults(func=cmd_write_tree)

    p = sub.add_parser("commit", help="record the staged changes")
    p.add_argument("-m", "--message", action="append", default=[], help="message (repeat for paragraphs)")
    p.add_argument("-F", "--file", help="read the message from a file")
    p.add_argument("-a", "--all", action="store_true", help="stage modified and deleted tracked files first")
    p.add_argument("--allow-empty", action="store_true", help="allow a commit that changes nothing")
    p.set_defaults(func=cmd_commit)

    p = sub.add_parser("rev-parse", help="print the object id a revision names")
    p.add_argument("--abbrev-ref", action="store_true", help="print the branch name instead (for HEAD)")
    p.add_argument("revs", nargs="+")
    p.set_defaults(func=cmd_rev_parse)


def index_tree(repo: Repository, index=None) -> str:
    index = index if index is not None else read_index(repo.index_path)
    return write_tree(repo.objects, ((e.path, e.mode_str, e.sha) for e in index))


def cmd_write_tree(args) -> int:
    repo = Repository.discover()
    write(index_tree(repo) + "\n")
    return 0


def clean_message(text: str) -> str:
    """Like ``git commit --cleanup=default`` minus comments: trim trailing whitespace and blank edges."""
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    collapsed = []
    for line in lines:
        if line or (collapsed and collapsed[-1]):
            collapsed.append(line)
    return "\n".join(collapsed) + "\n" if collapsed else ""


def cmd_commit(args) -> int:
    repo = Repository.discover()
    if args.file:
        raw = Path(args.file).read_text()
    elif args.message:
        raw = "\n\n".join(args.message)
    else:
        raise GitError("no commit message given; use -m <msg> or -F <file>", code=1, prefix="error")
    message = clean_message(raw)
    if not message:
        raise GitError("Aborting commit due to empty commit message.", code=1, prefix="")

    index = read_index(repo.index_path)
    if args.all:
        for entry in list(index):
            st = lstat(repo, entry.path)
            if st is None:
                index.remove(entry.path)
            elif is_modified(repo, index, entry, st):
                index.add(stage_file(repo, entry.path, st))
        write_index(index, repo.index_path)

    parent = refs.head_commit(repo)
    tree = index_tree(repo, index)
    if parent and not args.allow_empty:
        parent_tree = Commit.parse(repo.objects.read_type(parent, "commit")).tree
        if parent_tree == tree:
            raise GitError("nothing to commit, working tree clean", code=1, prefix="")
    if not parent and not len(index) and not args.allow_empty:
        raise GitError("nothing to commit (create/copy files and use \"minigit add\" to track)", code=1, prefix="")

    commit = Commit(
        tree=tree,
        parents=[parent] if parent else [],
        author=identity("author", repo.gitdir),
        committer=identity("committer", repo.gitdir),
        message=message,
    )
    sha = repo.objects.write("commit", commit.serialize())
    refs.update_head(repo, sha)

    branch = refs.current_branch(repo)
    where = branch if branch else "detached HEAD"
    if not parent:
        where += " (root-commit)"
    write(f"[{where} {repo.objects.abbreviate(sha)}] {commit.summary}\n")
    return 0


def cmd_rev_parse(args) -> int:
    repo = Repository.discover()
    out = []
    for rev in args.revs:
        if args.abbrev_ref and rev in ("HEAD", "@"):
            out.append(refs.current_branch(repo) or "HEAD")
        elif args.abbrev_ref:
            refs.resolve_revision(repo, rev)
            out.append(rev)
        else:
            out.append(refs.resolve_revision(repo, rev))
    write("".join(f"{line}\n" for line in out))
    return 0
