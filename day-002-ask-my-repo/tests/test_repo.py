"""Repo URL parsing, cloning (git mocked) and file filtering."""
import subprocess

import pytest

import repo
from repo import RepoError, clone_repo, iter_repo_files, parse_repo_url, read_text, should_skip


# --- URL parsing -------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://github.com/NJashwanth/commit-to-curiosity",
    "https://github.com/NJashwanth/commit-to-curiosity/",
    "https://github.com/NJashwanth/commit-to-curiosity.git",
    "  http://www.github.com/NJashwanth/commit-to-curiosity  ",
])
def test_parse_valid_urls(url):
    owner, name, clone_url = parse_repo_url(url)
    assert (owner, name) == ("NJashwanth", "commit-to-curiosity")
    assert clone_url == "https://github.com/NJashwanth/commit-to-curiosity.git"


@pytest.mark.parametrize("url", [
    "", None, "not a url", "https://gitlab.com/a/b", "https://github.com/onlyowner",
    "https://github.com/a/b/tree/main", "git@github.com:a/b.git", "https://github.com/../x",
    "https://github.com/a/..", "https://evil.com/https://github.com/a/b",
])
def test_parse_invalid_urls(url):
    with pytest.raises(RepoError):
        parse_repo_url(url)


# --- cloning -----------------------------------------------------------------

class FakeRun:
    def __init__(self, returncode=0, stderr="", raises=None):
        self.returncode, self.stderr, self.raises, self.calls = returncode, stderr, raises, []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        if self.raises:
            raise self.raises
        return subprocess.CompletedProcess(cmd, self.returncode, "", self.stderr)


def test_clone_is_shallow_and_never_prompts(monkeypatch, tmp_path):
    fake = FakeRun()
    monkeypatch.setattr(repo.subprocess, "run", fake)
    clone_repo("https://github.com/a/b.git", tmp_path / "x")
    cmd, kwargs = fake.calls[0]
    assert cmd[:4] == ["git", "clone", "--depth", "1"]
    assert cmd[-2:] == ["https://github.com/a/b.git", str(tmp_path / "x")]
    assert kwargs["env"]["GIT_TERMINAL_PROMPT"] == "0"


def test_clone_failure_reports_last_git_line(monkeypatch, tmp_path):
    monkeypatch.setattr(repo.subprocess, "run",
                        FakeRun(128, "Cloning...\nfatal: repository 'x' not found\n"))
    with pytest.raises(RepoError, match="repository 'x' not found"):
        clone_repo("https://github.com/a/b.git", tmp_path)


def test_clone_failure_without_stderr(monkeypatch, tmp_path):
    monkeypatch.setattr(repo.subprocess, "run", FakeRun(1, ""))
    with pytest.raises(RepoError, match="unknown error"):
        clone_repo("https://github.com/a/b.git", tmp_path)


def test_clone_without_git_installed(monkeypatch, tmp_path):
    monkeypatch.setattr(repo.subprocess, "run", FakeRun(raises=FileNotFoundError()))
    with pytest.raises(RepoError, match="git is not installed"):
        clone_repo("https://github.com/a/b.git", tmp_path)


def test_clone_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(repo.subprocess, "run",
                        FakeRun(raises=subprocess.TimeoutExpired("git", 300)))
    with pytest.raises(RepoError, match="timed out"):
        clone_repo("https://github.com/a/b.git", tmp_path)


# --- filtering by path and size ----------------------------------------------

@pytest.mark.parametrize("path", [
    "src/app.py", "README.md", "docs/guide.rst", "Makefile", "a/b/c/deep.ts", "new-day.sh",
    "build.gradle", "src/builder/main.py",
])
def test_should_keep_source_and_docs(path):
    assert not should_skip(path, 1_000)


@pytest.mark.parametrize("path", [
    "logo.png", "assets/photo.JPG", "docs/manual.pdf", "bin/tool.exe", "lib/native.so",
    "data/model.safetensors", "fonts/a.woff2", "archive.zip", "pkg/mod.pyc",
])
def test_should_skip_binaries(path):
    assert should_skip(path, 10)


@pytest.mark.parametrize("path", [
    "package-lock.json", "web/yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Cargo.lock",
    "go.sum", "Gemfile.lock", "Pipfile.lock", "UV.LOCK",
])
def test_should_skip_lockfiles(path):
    assert should_skip(path, 10)


@pytest.mark.parametrize("path", [
    "node_modules/left-pad/index.js", ".git/config", "a/b/node_modules/x.js",
    "__pycache__/m.py", ".venv/lib/x.py", "dist/bundle.js", "pkg/build/out.py", ".index/db.txt",
])
def test_should_skip_ignored_dirs(path):
    assert should_skip(path, 10)


def test_ignored_dir_name_only_matters_as_a_directory():
    assert not should_skip("docs/build", 10)  # a file called "build"
    assert not should_skip("src/vendor.py", 10)


def test_should_skip_minified_and_sourcemaps():
    assert should_skip("static/app.min.js", 10)
    assert should_skip("static/app.js.map", 10)


def test_size_limit_is_200kb_inclusive():
    assert not should_skip("big.txt", repo.MAX_FILE_BYTES)
    assert should_skip("big.txt", repo.MAX_FILE_BYTES + 1)


# --- reading and walking ------------------------------------------------------

def test_read_text(tmp_path):
    good, nul, bad = tmp_path / "a.txt", tmp_path / "b.txt", tmp_path / "c.txt"
    good.write_text("héllo\n", encoding="utf-8")
    nul.write_bytes(b"abc\0def")
    bad.write_bytes(b"\xff\xfe\xfa")
    assert read_text(good) == "héllo\n"
    assert read_text(nul) is None
    assert read_text(bad) is None


def test_iter_repo_files_applies_every_filter(tmp_path):
    def put(rel, content=b"x = 1\n"):
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content if isinstance(content, bytes) else content.encode())

    put("src/app.py", "print('hi')\n")
    put("README.md", "# Title\n")
    put("package-lock.json", "{}")
    put("node_modules/dep/index.js")
    put(".git/HEAD", "ref: refs/heads/main\n")
    put("logo.png", b"\x89PNG\r\n\x1a\n\0\0")
    put("blob.dat", b"\0\1\2\3")            # unknown extension, binary content
    put("huge.txt", "a" * (repo.MAX_FILE_BYTES + 1))
    put("latin1.txt", b"caf\xe9")
    (tmp_path / "link.py").symlink_to(tmp_path / "src" / "app.py")

    files = dict(iter_repo_files(tmp_path))
    assert files == {"README.md": "# Title\n", "src/app.py": "print('hi')\n"}
    assert list(files) == sorted(files)


def test_iter_repo_files_empty_dir(tmp_path):
    assert list(iter_repo_files(tmp_path)) == []
