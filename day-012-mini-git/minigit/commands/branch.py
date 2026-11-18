"""branch and checkout.

Checkout is a two-tree merge between the current HEAD tree and the target tree:

* paths that are the same in both trees are left alone, so local edits to them
  carry over to the new branch (as in Git);
* paths that differ are rewritten from the target tree, in the index and on disk;
* if any of those paths has staged or unstaged changes, or an untracked file sits
  where the target wants to write, nothing is touched and checkout aborts.
"""

from __future__ import annotations

import os
import shutil
import stat

from .. import refs
from ..errors import GitError
from ..ignore import IgnoreMatcher
from ..index import IndexEntry, read_index, write_index
from ..objects import Commit, flatten_tree
from ..output import GREEN, color_enabled, paint, write
from ..repo import Repository
from ..worktree import is_modified, lstat, walk
from .status import head_files


def register(sub) -> None:
    p = sub.add_parser("branch", help="list, create or delete branches")
    p.add_argument("-d", "--delete", action="store_true", help="delete a branch")
    p.add_argument("-D", dest="force_delete", action="store_true", help="delete even if not merged into HEAD")
    p.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    p.add_argument("name", nargs="?")
    p.add_argument("start", nargs="?", default="HEAD")
    p.set_defaults(func=cmd_branch)

    p = sub.add_parser("checkout", help="switch branches or detach HEAD at a commit")
    p.add_argument("-b", dest="new_branch", metavar="<branch>", help="create a branch and switch to it")
    p.add_argument("target", nargs="?", default=None)
    p.set_defaults(func=cmd_checkout)


# --- branch ----------------------------------------------------------------


def cmd_branch(args) -> int:
    repo = Repository.discover()
    if args.delete or args.force_delete:
        if not args.name:
            raise GitError("branch name required")
        return delete_branch(repo, args.name, force=args.force_delete)
    if args.name:
        create_branch(repo, args.name, args.start)
        return 0
    color = color_enabled(args.color)
    current = refs.current_branch(repo)
    lines = []
    if current is None and refs.head_commit(repo):
        lines.append("* " + paint(f"(HEAD detached at {repo.objects.abbreviate(refs.head_commit(repo))})", GREEN, color))
    for name in refs.branches(repo):
        lines.append(("* " + paint(name, GREEN, color)) if name == current else f"  {name}")
    write("".join(line + "\n" for line in lines))
    return 0


def create_branch(repo: Repository, name: str, start: str = "HEAD") -> str:
    refs.check_branch_name(name)
    if refs.read_ref(repo, f"refs/heads/{name}") is not None:
        raise GitError(f"a branch named '{name}' already exists")
    if start == "HEAD" and refs.head_commit(repo) is None:
        raise GitError(f"not a valid object name: '{refs.current_branch(repo) or 'HEAD'}'")
    sha = refs.resolve_commit(repo, start)
    refs.update_ref(repo, f"refs/heads/{name}", sha)
    return sha


def _is_ancestor(repo: Repository, ancestor: str, descendant: str | None) -> bool:
    todo, seen = [descendant] if descendant else [], set()
    while todo:
        sha = todo.pop()
        if sha == ancestor:
            return True
        if sha not in seen:
            seen.add(sha)
            todo += Commit.parse(repo.objects.read_type(sha, "commit")).parents
    return False


def delete_branch(repo: Repository, name: str, force: bool) -> int:
    sha = refs.read_ref(repo, f"refs/heads/{name}")
    if sha is None:
        raise GitError(f"branch '{name}' not found.", code=1, prefix="error")
    if name == refs.current_branch(repo):
        raise GitError(f"Cannot delete branch '{name}' checked out at '{repo.root}'", code=1, prefix="error")
    if not force and not _is_ancestor(repo, sha, refs.head_commit(repo)):
        raise GitError(
            f"The branch '{name}' is not fully merged.\n"
            f"If you are sure you want to delete it, run 'minigit branch -D {name}'.",
            code=1, prefix="error",
        )
    refs.delete_ref(repo, f"refs/heads/{name}")
    write(f"Deleted branch {name} (was {repo.objects.abbreviate(sha)}).\n")
    return 0


# --- checkout --------------------------------------------------------------


def cmd_checkout(args) -> int:
    repo = Repository.discover()
    if args.new_branch:
        refs.check_branch_name(args.new_branch)
        if refs.read_ref(repo, f"refs/heads/{args.new_branch}") is not None:
            raise GitError(f"a branch named '{args.new_branch}' already exists")
        if args.target is None and refs.head_commit(repo) is None:
            # On an unborn branch there is nothing to copy: just point HEAD elsewhere.
            refs.set_head_branch(repo, args.new_branch)
            write(f"Switched to a new branch '{args.new_branch}'\n")
            return 0
        target_sha = refs.resolve_commit(repo, args.target or "HEAD")
        switch_to(repo, target_sha)
        create_branch(repo, args.new_branch, target_sha)
        refs.set_head_branch(repo, args.new_branch)
        write(f"Switched to a new branch '{args.new_branch}'\n")
        return 0

    if args.target is None:
        raise GitError("you must specify a branch or commit to check out", code=129, prefix="usage")
    name = args.target
    is_branch = refs.read_ref(repo, f"refs/heads/{name}") is not None
    if is_branch and name == refs.current_branch(repo):
        write(f"Already on '{name}'\n")
        return 0
    target_sha = refs.resolve_commit(repo, name)
    switch_to(repo, target_sha)
    if is_branch:
        refs.set_head_branch(repo, name)
        write(f"Switched to branch '{name}'\n")
    else:
        refs.detach_head(repo, target_sha)
        summary = Commit.parse(repo.objects.read_type(target_sha, "commit")).summary
        write(
            f"Note: switching to '{name}'.\n\nYou are in 'detached HEAD' state. Commits you make here\n"
            "belong to no branch; create one with 'minigit checkout -b <name>' to keep them.\n\n"
            f"HEAD is now at {repo.objects.abbreviate(target_sha)} {summary}\n"
        )
    return 0


def switch_to(repo: Repository, target_sha: str) -> None:
    """Make the index and working tree match ``target_sha``, keeping unrelated local edits."""
    current = head_files(repo)
    target = flatten_tree(repo.objects, Commit.parse(repo.objects.read_type(target_sha, "commit")).tree)
    index = read_index(repo.index_path)
    ignore = IgnoreMatcher(repo.root, repo.gitdir)

    changed = sorted(p for p in set(current) | set(target) if current.get(p) != target.get(p))
    dirty, untracked = [], []
    for path in changed:
        entry = index.get(path)
        staged = (entry.mode_str, entry.sha) if entry else None
        st = lstat(repo, path)
        if entry is None:
            if path in current:
                if path in target:
                    dirty.append(path)  # a staged removal the target would undo
            elif path in target and _blocks(repo, index, ignore, path, st) and not ignore.is_ignored(path):
                untracked.append(path)
            continue
        if st is None and path not in target and staged == current.get(path):
            continue  # already deleted on disk, and the target deletes it too
        worktree_dirty = st is None or is_modified(repo, index, entry, st)
        if staged == target.get(path) and not worktree_dirty:
            continue  # already exactly what the target wants
        if staged != current.get(path) or worktree_dirty:
            dirty.append(path)

    if dirty:
        raise GitError(
            "Your local changes to the following files would be overwritten by checkout:\n"
            + "".join(f"\t{p}\n" for p in dirty)
            + "Please commit your changes or stash them before you switch branches.\nAborting",
            code=1, prefix="error",
        )
    if untracked:
        raise GitError(
            "The following untracked working tree files would be overwritten by checkout:\n"
            + "".join(f"\t{p}\n" for p in untracked)
            + "Please move or remove them before you switch branches.\nAborting",
            code=1, prefix="error",
        )

    umask = os.umask(0)
    os.umask(umask)
    # Removals first, so a directory that becomes a file (or the reverse) is out of the way.
    for path in changed:
        if path not in target:
            _remove_file(repo, path)
            index.remove(path)
    for path in changed:
        if path in target:
            mode, sha = target[path]
            _write_file(repo, path, mode, repo.objects.read_type(sha, "blob"), umask)
            index.add(IndexEntry.from_stat(path, sha, os.lstat(repo.abspath(path))))
    write_index(index, repo.index_path)


def _blocks(repo: Repository, index, ignore: IgnoreMatcher, path: str, st) -> bool:
    """Would writing ``path`` clobber an untracked file or directory on disk?"""
    if st is not None:
        return True
    full = repo.abspath(path)
    if full.is_dir() and not full.is_symlink():
        # A directory in the way only matters if it holds files Git doesn't track.
        return any(f not in index for f in walk(repo, ignore, path))
    parts = path.split("/")
    for i in range(1, len(parts)):  # an untracked file where a directory must go
        ancestor = "/".join(parts[:i])
        if lstat(repo, ancestor) is not None and ancestor not in index:
            return True
    return False


def _write_file(repo: Repository, path: str, mode: str, data: bytes, umask: int) -> None:
    full = repo.abspath(path)
    # Clear anything in the way: a file where a directory must go, or vice versa.
    parent = full.parent
    while parent != repo.root and not parent.is_dir():
        if parent.exists() or parent.is_symlink():
            parent.unlink()
            break
        parent = parent.parent
    full.parent.mkdir(parents=True, exist_ok=True)
    if full.is_dir() and not full.is_symlink():
        shutil.rmtree(full)
    elif full.exists() or full.is_symlink():
        full.unlink()
    if mode == "120000":
        os.symlink(os.fsdecode(data), full)
        return
    full.write_bytes(data)
    os.chmod(full, (0o777 if mode == "100755" else 0o666) & ~umask)


def _remove_file(repo: Repository, path: str) -> None:
    full = repo.abspath(path)
    try:
        if stat.S_ISDIR(os.lstat(full).st_mode):
            return
        full.unlink()
    except (FileNotFoundError, NotADirectoryError):
        pass
    # Prune directories left empty, but never the repository root.
    parent = full.parent
    while parent != repo.root:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
