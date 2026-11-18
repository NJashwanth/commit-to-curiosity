"""Finding and creating repositories."""

from __future__ import annotations

import os
import unicodedata
from pathlib import Path

from .errors import GitError
from .objects import ObjectStore

DEFAULT_BRANCH = "main"


class Repository:
    def __init__(self, root: Path | str):
        self.root = Path(root)
        self.gitdir = self.root / ".git"
        self.objects = ObjectStore(self.gitdir)

    @property
    def index_path(self) -> Path:
        return self.gitdir / "index"

    @classmethod
    def discover(cls, start: Path | str | None = None) -> "Repository":
        """Walk up from ``start`` (default: cwd) to the first directory holding ``.git``."""
        here = Path(os.path.realpath(start or os.getcwd()))
        for candidate in (here, *here.parents):
            if (candidate / ".git" / "HEAD").is_file():
                return cls(candidate)
        raise GitError("not a git repository (or any of the parent directories): .git")

    @classmethod
    def init(cls, path: Path | str, branch: str = DEFAULT_BRANCH) -> tuple["Repository", bool]:
        """Create (or re-initialise) a repository. Returns the repo and whether it existed."""
        root = Path(os.path.realpath(path))
        repo = cls(root)
        existed = (repo.gitdir / "HEAD").is_file()
        for sub in ("objects/info", "objects/pack", "refs/heads", "refs/tags", "info"):
            (repo.gitdir / sub).mkdir(parents=True, exist_ok=True)
        if not existed:
            (repo.gitdir / "HEAD").write_text(f"ref: refs/heads/{branch}\n")
            (repo.gitdir / "description").write_text(
                "Unnamed repository; edit this file 'description' to name the repository.\n"
            )
            (repo.gitdir / "info" / "exclude").write_text(
                "# git ls-files --others --exclude-from=.git/info/exclude\n"
                "# Lines that start with '#' are comments.\n"
            )
            (repo.gitdir / "config").write_text(_initial_config(repo.gitdir))
        return repo, existed

    def relpath(self, path: Path | str) -> str:
        """Repository-relative POSIX path for ``path`` (absolute or relative to cwd)."""
        absolute = os.path.normpath(os.path.join(os.getcwd(), path))
        rel = os.path.relpath(absolute, self.root)
        if rel == ".":
            return ""
        if rel == ".." or rel.startswith(".." + os.sep):
            raise GitError(f"{path}: '{path}' is outside repository at '{self.root}'")
        return rel.replace(os.sep, "/")

    def abspath(self, rel: str) -> Path:
        return self.root / rel


def _initial_config(gitdir: Path) -> str:
    lines = [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tfilemode = true",
        "\tbare = false",
        "\tlogallrefupdates = true",
    ]
    # Like `git init`, probe the filesystem rather than guess from the platform.
    probe = gitdir / "config"
    probe.write_text("")
    if (gitdir / "CoNfIg").exists():
        lines.append("\tignorecase = true")
    nfc = gitdir / unicodedata.normalize("NFC", "ä")
    nfd = gitdir / unicodedata.normalize("NFD", "ä")
    try:
        nfd.write_text("")
        if nfc.exists():
            lines.append("\tprecomposeunicode = true")
    except OSError:  # pragma: no cover - filesystems that reject the name
        pass
    finally:
        for leftover in (nfd, nfc):
            if leftover.exists():
                leftover.unlink()
    return "\n".join(lines) + "\n"
