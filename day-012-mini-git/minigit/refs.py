"""References: HEAD, branches under refs/heads, and turning names into object ids.

A ref is a text file holding a 40-hex id. HEAD is usually *symbolic*: it holds
``ref: refs/heads/main`` and follows that branch, so committing moves the branch.
When HEAD holds an id directly it is *detached*. Refs that real Git has packed into
``.git/packed-refs`` are read too.
"""

from __future__ import annotations

import os
import re

from .errors import GitError
from .objects import Commit, is_hex
from .repo import Repository

SYMREF_PREFIX = "ref: "


def _ref_file(repo: Repository, ref: str):
    return repo.gitdir / ref


def packed_refs(repo: Repository) -> dict[str, str]:
    path = repo.gitdir / "packed-refs"
    refs: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            if line and not line.startswith(("#", "^")):
                sha, _, name = line.partition(" ")
                refs[name] = sha
    return refs


def read_ref(repo: Repository, ref: str) -> str | None:
    """Raw contents of a ref: an id, ``ref: <target>``, or None if it doesn't exist."""
    path = _ref_file(repo, ref)
    if path.is_file():
        return path.read_text().strip()
    return packed_refs(repo).get(ref)


def resolve_ref(repo: Repository, ref: str, depth: int = 0) -> str | None:
    """Follow symbolic refs down to an object id (None for an unborn branch)."""
    if depth > 5:
        raise GitError(f"symbolic ref loop at {ref}")
    value = read_ref(repo, ref)
    if value is None:
        return None
    if value.startswith(SYMREF_PREFIX):
        return resolve_ref(repo, value[len(SYMREF_PREFIX):], depth + 1)
    return value


def update_ref(repo: Repository, ref: str, value: str) -> None:
    """Atomically write a ref (an id, or ``ref: target`` for a symbolic ref)."""
    path = _ref_file(repo, ref)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_name(path.name + ".lock")
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        raise GitError(f"cannot lock ref '{ref}': Unable to create '{lock}': File exists.") from None
    with os.fdopen(fd, "w") as fh:
        fh.write(value + "\n")
    os.replace(lock, path)


def delete_ref(repo: Repository, ref: str) -> None:
    path = _ref_file(repo, ref)
    if path.is_file():
        path.unlink()
    packed = repo.gitdir / "packed-refs"
    if ref in packed_refs(repo):
        lines = [line for line in packed.read_text().splitlines(keepends=True) if not line.rstrip("\n").endswith(" " + ref)]
        packed.write_text("".join(lines))


# --- HEAD ------------------------------------------------------------------


def head_target(repo: Repository) -> str | None:
    """The ref HEAD points at (``refs/heads/main``), or None when detached."""
    value = read_ref(repo, "HEAD") or ""
    return value[len(SYMREF_PREFIX):] if value.startswith(SYMREF_PREFIX) else None


def current_branch(repo: Repository) -> str | None:
    target = head_target(repo)
    if target and target.startswith("refs/heads/"):
        return target[len("refs/heads/"):]
    return None


def head_commit(repo: Repository) -> str | None:
    return resolve_ref(repo, "HEAD")


def update_head(repo: Repository, sha: str) -> None:
    """Move whatever HEAD stands for: its branch, or HEAD itself when detached."""
    update_ref(repo, head_target(repo) or "HEAD", sha)


def set_head_branch(repo: Repository, branch: str) -> None:
    update_ref(repo, "HEAD", f"{SYMREF_PREFIX}refs/heads/{branch}")


def detach_head(repo: Repository, sha: str) -> None:
    update_ref(repo, "HEAD", sha)


# --- branches --------------------------------------------------------------


def branches(repo: Repository) -> dict[str, str]:
    """``{name: sha}`` for every local branch, loose and packed."""
    found = {name[len("refs/heads/"):]: sha for name, sha in packed_refs(repo).items() if name.startswith("refs/heads/")}
    heads = repo.gitdir / "refs" / "heads"
    for dirpath, _, filenames in os.walk(heads):
        for filename in filenames:
            if filename.endswith(".lock"):
                continue
            full = os.path.join(dirpath, filename)
            name = os.path.relpath(full, heads).replace(os.sep, "/")
            found[name] = open(full).read().strip()
    return dict(sorted(found.items()))


_BAD_REF = re.compile(r"(^[-/.]|\.\.|//|@\{|[\x00-\x20\x7f~^:?*\[\\]|/\.|\.lock$|\.$|/$)")


def check_branch_name(name: str) -> None:
    """A subset of ``git check-ref-format --branch``."""
    if not name or name == "HEAD" or name == "@" or _BAD_REF.search(name) or name.endswith(".lock"):
        raise GitError(f"'{name}' is not a valid branch name")


# --- revisions -------------------------------------------------------------

_SUFFIX = re.compile(r"(\^\d*|~\d*)$")


def resolve_revision(repo: Repository, rev: str) -> str:
    """Turn ``HEAD``, ``main``, ``refs/heads/x``, ``a1b2c3`` or ``HEAD~2^`` into an id."""
    m = _SUFFIX.search(rev)
    if m and m.start() > 0:
        base = resolve_revision(repo, rev[: m.start()])
        op, num = m.group(1)[0], m.group(1)[1:]
        n = int(num) if num else 1
        if op == "^":
            if n == 0:
                return base
            parents = _parents(repo, base, rev)
            if n > len(parents):
                raise GitError(f"ambiguous argument '{rev}': unknown revision or path not in the working tree.")
            return parents[n - 1]
        for _ in range(n):
            parents = _parents(repo, base, rev)
            if not parents:
                raise GitError(f"ambiguous argument '{rev}': unknown revision or path not in the working tree.")
            base = parents[0]
        return base

    name = "HEAD" if rev == "@" else rev
    candidates = [name] if name == "HEAD" or name.startswith("refs/") else [
        f"refs/{name}", f"refs/tags/{name}", f"refs/heads/{name}", f"refs/remotes/{name}"
    ]
    for ref in candidates:
        if read_ref(repo, ref) is not None:
            sha = resolve_ref(repo, ref)
            if sha is None:
                break  # an unborn branch
            return sha
    if name == "HEAD":
        raise GitError("ambiguous argument 'HEAD': unknown revision or path not in the working tree.")
    if is_hex(name.lower()) and len(name) >= 4:
        return repo.objects.resolve_prefix(name)
    raise GitError(f"Not a valid object name {rev}")


def _parents(repo: Repository, sha: str, rev: str) -> list[str]:
    obj_type, data = repo.objects.read(sha)
    if obj_type != "commit":
        raise GitError(f"{rev}: {sha} is a {obj_type}, not a commit")
    return Commit.parse(data).parents


def resolve_commit(repo: Repository, rev: str) -> str:
    sha = resolve_revision(repo, rev)
    obj_type, _ = repo.objects.read(sha)
    if obj_type != "commit":
        raise GitError(f"{rev} is a {obj_type}, not a commit")
    return sha
