"""Object store, hash-object and cat-file, checked against the real git binary."""

import subprocess
import sys
import zlib

import pytest
from helpers import git, git_out, mg, write_file

from minigit.errors import GitError
from minigit.objects import (
    Commit,
    ObjectStore,
    Signature,
    TreeEntry,
    hash_object,
    parse_tree,
    serialize_tree,
    validate,
)
from minigit.output import quote_path
from minigit.repo import Repository

BLOBS = [
    b"",
    b"hello\n",
    b"no trailing newline",
    "unicode: café ☕ 日本\n".encode(),
    bytes(range(256)) * 4,  # binary, includes NUL
    b"x" * 100_000,
]


@pytest.mark.parametrize("data", BLOBS, ids=["empty", "hello", "no-newline", "unicode", "binary", "large"])
def test_blob_sha_matches_git_hash_object(tmp_path, data):
    f = write_file(tmp_path, "f", data)
    expected = git_out(tmp_path, "hash-object", str(f)).strip()
    assert hash_object(data) == expected
    assert mg(tmp_path, "hash-object", str(f)).text.strip() == expected
    assert mg(tmp_path, "hash-object", "--stdin", stdin=data).text.strip() == expected


def test_empty_blob_has_the_well_known_id():
    assert hash_object(b"") == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"


def test_git_reads_every_blob_minigit_writes(repo):
    for data in BLOBS:
        sha = mg(repo, "hash-object", "-w", "--stdin", stdin=data).text.strip()
        assert git(repo, "cat-file", "-t", sha).stdout == b"blob\n"
        assert git(repo, "cat-file", "-p", sha).stdout == data
    git(repo, "fsck", "--strict")


def test_object_file_layout_and_compression(repo):
    sha = mg(repo, "hash-object", "-w", "--stdin", stdin=b"hello\n").text.strip()
    path = repo / ".git" / "objects" / sha[:2] / sha[2:]
    assert zlib.decompress(path.read_bytes()) == b"blob 6\0hello\n"
    assert path.stat().st_mode & 0o777 == 0o444
    # writing the same object again is a no-op
    assert mg(repo, "hash-object", "-w", "--stdin", stdin=b"hello\n").text.strip() == sha


def test_minigit_reads_objects_git_wrote(repo):
    write_file(repo, "a.txt", "alpha\n")
    write_file(repo, "dir/b.txt", "beta\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "from real git")
    for rev in ("HEAD", "HEAD^{tree}", "HEAD:dir", "HEAD:a.txt"):
        sha = git_out(repo, "rev-parse", rev).strip()
        assert mg(repo, "cat-file", "-p", sha).out == git(repo, "cat-file", "-p", sha).stdout
        assert mg(repo, "cat-file", "-t", sha).out == git(repo, "cat-file", "-t", sha).stdout
        assert mg(repo, "cat-file", "-s", sha).out == git(repo, "cat-file", "-s", sha).stdout


def test_tree_serialization_matches_git_mktree(repo):
    blob = mg(repo, "hash-object", "-w", "--stdin", stdin=b"x\n").text.strip()
    sub = git_out(repo, "mktree", stdin=f"100644 blob {blob}\tinner\n".encode()).strip()
    # Names chosen to exercise Git's "directories sort as if they end in /" rule.
    entries = [
        TreeEntry("100644", "a.txt", blob),
        TreeEntry("40000", "a", sub),
        TreeEntry("100644", "a0", blob),
        TreeEntry("100755", "run.sh", blob),
        TreeEntry("120000", "link", blob),
        TreeEntry("100644", "café", blob),
    ]
    mktree_input = "".join(f"{e.mode:0>6} {e.type} {e.sha}\t{e.name}\n" for e in entries).encode()
    expected = git_out(repo, "mktree", stdin=mktree_input).strip()
    data = serialize_tree(entries)
    assert hash_object(data, "tree") == expected
    assert [e.name for e in parse_tree(data)] == ["a.txt", "a", "a0", "café", "link", "run.sh"]
    sha = mg(repo, "hash-object", "-w", "-t", "tree", "--stdin", stdin=data).text.strip()
    assert sha == expected
    out = mg(repo, "cat-file", "-p", sha).text
    assert out == git_out(repo, "cat-file", "-p", sha)
    assert f"040000 tree {sub}\ta\n" in out
    assert '"caf\\303\\251"' in out


def test_commit_serialization_matches_git_commit_tree(repo):
    tree = git_out(repo, "mktree", stdin=b"").strip()
    expected = git_out(repo, "commit-tree", tree, "-m", "first").strip()
    author = Signature("Test Author", "author@example.com", 1700000000, "+0530")
    committer = Signature("Test Committer", "committer@example.com", 1700000000, "+0530")
    commit = Commit(tree, [], author, committer, "first\n")
    assert hash_object(commit.serialize(), "commit") == expected
    parsed = Commit.parse(git(repo, "cat-file", "commit", expected).stdout)
    assert parsed == commit
    child = git_out(repo, "commit-tree", tree, "-p", expected, "-m", "second\n\nbody line").strip()
    assert Commit.parse(git(repo, "cat-file", "commit", child).stdout).parents == [expected]
    assert hash_object(Commit(tree, [expected], author, committer, "second\n\nbody line\n").serialize(), "commit") == child


def test_commit_with_multiline_header_round_trips():
    raw = (
        b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"
        b"author A <a@x> 1 +0000\ncommitter C <c@x> 2 -0700\n"
        b"gpgsig -----BEGIN-----\n line two\n -----END-----\n\nmsg\n"
    )
    c = Commit.parse(raw)
    assert c.extra == [("gpgsig", "-----BEGIN-----\nline two\n-----END-----")]
    assert c.serialize() == raw
    assert c.committer.tz == "-0700"


def test_signature_dates_and_summary():
    sig = Signature.parse("Jashwanth Neela <j@example.com> 1700000000 +0530")
    assert sig.git_date() == "Wed Nov 15 03:43:20 2023 +0530"
    assert Signature.parse("X <x@y> 0 -0130").git_date() == "Wed Dec 31 22:30:00 1969 -0130"
    with pytest.raises(GitError):
        Signature.parse("garbage")
    c = Commit("t", [], sig, sig, "line one\nline two\n\nbody\n")
    assert c.summary == "line one line two"


def test_cat_file_short_prefix_resolution(repo):
    sha = mg(repo, "hash-object", "-w", "--stdin", stdin=b"hello\n").text.strip()
    for n in (4, 7, 12, 40):
        assert mg(repo, "cat-file", "-p", sha[:n]).out == b"hello\n"
    assert mg(repo, "cat-file", "-p", sha.upper()[:8]).out == b"hello\n"
    assert mg(repo, "cat-file", "blob", sha[:7]).out == b"hello\n"
    assert mg(repo, "cat-file", "-e", sha[:7]).code == 0


def find_colliding_blobs():
    seen = {}
    i = 0
    while True:
        data = f"blob number {i}\n".encode()
        prefix = hash_object(data)[:4]
        if prefix in seen:
            return seen[prefix], data, prefix
        seen[prefix] = data
        i += 1


def test_ambiguous_short_sha_is_a_clear_error(repo):
    a, b, prefix = find_colliding_blobs()
    sha_a = mg(repo, "hash-object", "-w", "--stdin", stdin=a).text.strip()
    sha_b = mg(repo, "hash-object", "-w", "--stdin", stdin=b).text.strip()
    result = mg(repo, "cat-file", "-p", prefix, check=False)
    assert result.code == 128
    assert f"error: short object ID {prefix} is ambiguous" in result.err
    assert "hint: The candidates are:" in result.err
    assert f"{min(sha_a, sha_b)} blob" in result.err and f"{max(sha_a, sha_b)} blob" in result.err
    assert result.err.rstrip().endswith(f"fatal: Not a valid object name {prefix}")
    # real git agrees it is ambiguous
    assert "ambiguous" in git(repo, "cat-file", "-p", prefix, check=False).stderr.decode()
    # one more character settles it
    longer = sha_a[: next(i for i in range(5, 40) if sha_a[:i] != sha_b[:i])]
    assert mg(repo, "cat-file", "-p", longer).out == a


@pytest.mark.parametrize("name", ["deadbeef", "abc", "nothex!", "0" * 40, "zz" * 20])
def test_unknown_object_is_a_clear_error(repo, name):
    result = mg(repo, "cat-file", "-t", name, check=False)
    assert result.code == 128
    assert result.err.strip() == f"fatal: Not a valid object name {name}"
    assert mg(repo, "cat-file", "-e", name, check=False).code == 1


def test_cat_file_type_mismatch_and_usage_errors(repo):
    sha = mg(repo, "hash-object", "-w", "--stdin", stdin=b"x").text.strip()
    r = mg(repo, "cat-file", "commit", sha, check=False)
    assert r.code == 128 and "is a blob, not a commit" in r.err
    assert mg(repo, "cat-file", sha, check=False).code == 129
    assert mg(repo, "cat-file", "-p", sha, sha, check=False).code == 129


def test_corrupt_objects_are_reported(repo):
    store = ObjectStore(repo / ".git")
    sha = store.write("blob", b"data")
    path = store.path(sha)
    path.chmod(0o644)
    path.write_bytes(b"not zlib")
    with pytest.raises(GitError, match="corrupt"):
        store.read(sha)
    path.write_bytes(zlib.compress(b"blob 99\0data"))
    with pytest.raises(GitError, match="bad header"):
        store.read(sha)
    path.write_bytes(zlib.compress(b"nonsense"))
    with pytest.raises(GitError, match="bad header"):
        store.read(sha)
    with pytest.raises(GitError, match="invalid object type"):
        store.write("widget", b"")
    with pytest.raises(GitError, match="corrupt tree"):
        parse_tree(b"100644 name\0short")
    with pytest.raises(GitError, match="corrupt commit"):
        Commit.parse(b"tree abc\n\nno author")
    with pytest.raises(GitError):
        validate("tree", b"garbage")
    validate("blob", b"anything goes")


def test_hash_object_rejects_malformed_commit_and_missing_file(repo):
    r = mg(repo, "hash-object", "-t", "commit", "--stdin", stdin=b"hello", check=False)
    assert r.code == 128 and "corrupt commit" in r.err
    r = mg(repo, "hash-object", "missing.txt", check=False)
    assert r.code == 128 and "could not open 'missing.txt'" in r.err


def test_abbreviate_extends_past_collisions(repo):
    a, b, prefix = find_colliding_blobs()
    store = ObjectStore(repo / ".git")
    sha_a, sha_b = store.write("blob", a), store.write("blob", b)
    short = store.abbreviate(sha_a, 4)
    assert len(short) > 4 and not sha_b.startswith(short)
    assert ObjectStore(repo / "nowhere").abbreviate("ab" * 20) == "abababa"


def test_init_creates_a_repo_real_git_accepts(tmp_path):
    out = mg(tmp_path, "init", "proj").text
    root = tmp_path / "proj"
    assert out == f"Initialized empty Git repository in {(root / '.git').resolve()}/\n"
    assert (root / ".git" / "HEAD").read_text() == "ref: refs/heads/main\n"
    assert "repositoryformatversion = 0" in (root / ".git" / "config").read_text()
    assert git_out(root, "rev-parse", "--git-dir").strip() == ".git"
    assert git_out(root, "symbolic-ref", "HEAD").strip() == "refs/heads/main"
    git(root, "status")
    git(root, "fsck")
    again = mg(tmp_path, "init", "proj").text
    assert again.startswith("Reinitialized existing Git repository")
    mg(tmp_path, "init", "-b", "trunk", "other")
    assert (tmp_path / "other" / ".git" / "HEAD").read_text() == "ref: refs/heads/trunk\n"


def test_commands_outside_a_repository_fail(tmp_path):
    r = mg(tmp_path, "cat-file", "-p", "abcd", check=False)
    assert r.code == 128
    assert "not a git repository" in r.err


def test_repository_discovery_from_subdirectory(repo):
    (repo / "a" / "b").mkdir(parents=True)
    assert Repository.discover(repo / "a" / "b").root == repo.resolve()


def test_relpath_rejects_paths_outside_repo(repo, monkeypatch):
    r = Repository(repo.resolve())
    monkeypatch.chdir(repo)
    assert r.relpath(".") == ""
    assert r.relpath("x/../y") == "y"
    with pytest.raises(GitError, match="outside repository"):
        r.relpath("../elsewhere")


def test_quote_path_matches_git():
    assert quote_path("plain name.txt") == "plain name.txt"
    assert quote_path("café") == '"caf\\303\\251"'
    assert quote_path('tab\there "q" \\') == '"tab\\there \\"q\\" \\\\"'
    assert quote_path("bell\x07\x01") == '"bell\\a\\001"'


def test_python_dash_m_entry_point(tmp_path):
    proc = subprocess.run([sys.executable, "-m", "minigit", "--version"], capture_output=True, text=True,
                          cwd=str(__import__("pathlib").Path(__file__).parent.parent))
    assert proc.returncode == 0 and proc.stdout.startswith("minigit ")
    assert mg(tmp_path, check=False).code == 1  # no command: help + exit 1
