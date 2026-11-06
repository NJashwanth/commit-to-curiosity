"""Clone a GitHub repo and decide which of its files are worth indexing."""
import os
import re
import subprocess
from pathlib import Path

MAX_FILE_BYTES = 200 * 1024

IGNORED_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".vscode", ".gradle", ".dart_tool", ".next",
    ".nuxt", ".turbo", ".cache", "dist", "build", "target", "coverage", "vendor", "Pods",
    ".index",
}

LOCKFILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lockb",
    "poetry.lock", "pipfile.lock", "uv.lock", "cargo.lock", "go.sum", "composer.lock",
    "gemfile.lock", "pubspec.lock", "podfile.lock", "mix.lock",
}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".svgz", ".psd",
    ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".class", ".pyc", ".pyo", ".whl",
    ".mp3", ".mp4", ".mov", ".avi", ".wav", ".ogg", ".flac", ".webm",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".db", ".sqlite", ".sqlite3", ".pkl", ".pickle", ".npy", ".npz", ".parquet", ".onnx",
    ".pt", ".pth", ".safetensors", ".h5", ".ckpt",
}

MINIFIED_SUFFIXES = (".min.js", ".min.css", ".map")

GITHUB_URL = re.compile(
    r"^https?://(?:www\.)?github\.com/(?P<owner>[A-Za-z0-9_.-]+)/(?P<name>[A-Za-z0-9_.-]+?)"
    r"(?:\.git)?/?$"
)


class RepoError(Exception):
    """The repo URL is invalid or the repo could not be cloned."""


def parse_repo_url(url):
    """Return (owner, name, clone_url) for a GitHub repo URL, or raise RepoError."""
    match = GITHUB_URL.match((url or "").strip())
    if not match or match["name"] in {".", ".."} or match["owner"] in {".", ".."}:
        raise RepoError(f"Not a GitHub repo URL: {url!r}. Expected https://github.com/<owner>/<repo>")
    owner, name = match["owner"], match["name"]
    return owner, name, f"https://github.com/{owner}/{name}.git"


def clone_repo(clone_url, dest):
    """Shallow clone (depth 1) into dest. Raises RepoError with git's message on failure."""
    try:
        result = subprocess.run(
            ["git", "clone", "--depth", "1", "--quiet", clone_url, str(dest)],
            capture_output=True, text=True, timeout=300,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except FileNotFoundError as exc:
        raise RepoError("git is not installed or not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise RepoError("git clone timed out") from exc
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        raise RepoError(f"git clone failed: {detail[-1] if detail else 'unknown error'}")


def should_skip(rel_path, size):
    """True if a file should not be indexed, judged from its relative path and size alone."""
    path = Path(rel_path)
    if any(part in IGNORED_DIRS for part in path.parts[:-1]):
        return True
    name = path.name.lower()
    if name in LOCKFILES or name.endswith(MINIFIED_SUFFIXES):
        return True
    if path.suffix.lower() in BINARY_EXTENSIONS:
        return True
    return size > MAX_FILE_BYTES


def read_text(path):
    """File contents as text, or None if it looks binary or is not valid UTF-8."""
    data = path.read_bytes()
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def iter_repo_files(root):
    """Yield (relative posix path, text) for every indexable file under root, sorted by path."""
    root = Path(root)
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        rel = path.relative_to(root)
        if should_skip(rel, path.stat().st_size):
            continue
        text = read_text(path)
        if text is not None:
            yield rel.as_posix(), text
