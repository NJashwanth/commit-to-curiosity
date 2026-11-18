"""write-tree, commit, refs and identity, verified with real git."""

import os

import pytest
from helpers import git, git_out, mg, write_file
from test_index import make_mixed_tree

from minigit import refs
from minigit.config import DEFAULT_EMAIL, DEFAULT_NAME, identity, parse_config, parse_date
from minigit.errors import GitError
from minigit.repo import Repository


def test_write_tree_matches_git_write_tree(repo):
    make_mixed_tree(repo)
    write_file(repo, "a.txt", "a\n")
    write_file(repo, "a/inner.txt", "i\n")  # "a" dir sorts after "a.txt"
    write_file(repo, "a0", "0\n")
    mg(repo, "add", ".")
    ours = mg(repo, "write-tree").text.strip()
    assert ours == git_out(repo, "write-tree").strip()
    git(repo, "fsck", "--strict")


def test_commit_sha_matches_git_commit_tree(repo):
    write_file(repo, "hello.txt", "hello\n")
    mg(repo, "add", ".")
    out = mg(repo, "commit", "-m", "first commit").text
    head = (repo / ".git" / "refs" / "heads" / "main").read_text().strip()
    assert out == f"[main (root-commit) {head[:7]}] first commit\n"
    tree = git_out(repo, "write-tree").strip()
    assert git_out(repo, "commit-tree", tree, "-m", "first commit").strip() == head

    write_file(repo, "hello.txt", "hello again\n")
    mg(repo, "add", "hello.txt")
    mg(repo, "commit", "-m", "second", "-m", "with a body")
    second = git_out(repo, "rev-parse", "HEAD").strip()
    tree2 = git_out(repo, "write-tree").strip()
    expected = git_out(repo, "commit-tree", tree2, "-p", head, "-m", "second", "-m", "with a body").strip()
    assert second == expected
    assert git_out(repo, "rev-parse", "HEAD~1").strip() == head


def test_real_git_log_and_fsck_accept_minigit_commits(repo):
    make_mixed_tree(repo)
    mg(repo, "add", ".")
    mg(repo, "commit", "-m", "one")
    write_file(repo, "src/new.py", "n = 2\n")
    mg(repo, "add", "src")
    mg(repo, "commit", "-m", "two")
    log = git_out(repo, "log", "--format=%an <%ae>|%cn|%s|%ad", "--date=raw")
    assert log.splitlines() == [
        "Test Author <author@example.com>|Test Committer|two|1700000000 +0530",
        "Test Author <author@example.com>|Test Committer|one|1700000000 +0530",
    ]
    fsck = git(repo, "fsck", "--strict", "--full")
    assert fsck.returncode == 0 and b"error" not in fsck.stderr.lower()
    assert git_out(repo, "status", "--porcelain") == ""
    assert git_out(repo, "ls-tree", "-r", "--name-only", "HEAD").count("\n") == 9


def test_head_is_symbolic_and_branch_moves(repo):
    write_file(repo, "f", "1\n")
    mg(repo, "add", "f")
    mg(repo, "commit", "-m", "c1")
    assert (repo / ".git" / "HEAD").read_text() == "ref: refs/heads/main\n"
    assert git_out(repo, "symbolic-ref", "HEAD").strip() == "refs/heads/main"
    assert mg(repo, "rev-parse", "HEAD").text == git_out(repo, "rev-parse", "main")
    assert mg(repo, "rev-parse", "--abbrev-ref", "HEAD").text == "main\n"


def test_detached_head_commit_moves_head_only(repo):
    write_file(repo, "f", "1\n")
    mg(repo, "add", "f")
    mg(repo, "commit", "-m", "c1")
    first = git_out(repo, "rev-parse", "HEAD").strip()
    (repo / ".git" / "HEAD").write_text(first + "\n")
    write_file(repo, "f", "2\n")
    mg(repo, "add", "f")
    out = mg(repo, "commit", "-m", "detached work").text
    assert out.startswith("[detached HEAD ")
    head = (repo / ".git" / "HEAD").read_text().strip()
    assert head != first and git_out(repo, "rev-parse", "main").strip() == first
    assert git_out(repo, "rev-parse", "HEAD~1").strip() == first
    assert mg(repo, "rev-parse", "--abbrev-ref", "HEAD").text == "HEAD\n"
    git(repo, "fsck")


def test_commit_errors(repo):
    r = mg(repo, "commit", "-m", "nothing", check=False)
    assert r.code == 1 and "nothing to commit" in r.err
    write_file(repo, "f", "1\n")
    mg(repo, "add", "f")
    r = mg(repo, "commit", check=False)
    assert r.code == 1 and "no commit message" in r.err
    r = mg(repo, "commit", "-m", "  \n\n ", check=False)
    assert r.code == 1 and "empty commit message" in r.err
    mg(repo, "commit", "-m", "c1")
    r = mg(repo, "commit", "-m", "again", check=False)
    assert r.code == 1 and "nothing to commit, working tree clean" in r.err
    mg(repo, "commit", "--allow-empty", "-m", "empty on purpose")
    assert git_out(repo, "log", "--format=%s") == "empty on purpose\nc1\n"


def test_commit_all_and_message_file(repo, tmp_path):
    write_file(repo, "a", "1\n")
    write_file(repo, "b", "1\n")
    mg(repo, "add", ".")
    mg(repo, "commit", "-m", "base")
    write_file(repo, "a", "2\n")
    (repo / "b").unlink()
    msg = tmp_path / "msg.txt"
    msg.write_text("\n\nsubject line   \n\n\n\nbody   \n\n")
    mg(repo, "commit", "-a", "-F", str(msg))
    assert git(repo, "cat-file", "commit", "HEAD").stdout.endswith(b"\n\nsubject line\n\nbody\n")
    assert git_out(repo, "ls-tree", "--name-only", "HEAD") == "a\n"
    assert git_out(repo, "status", "--porcelain") == ""


def test_minigit_commits_on_top_of_git_history(repo):
    write_file(repo, "a", "1\n")
    git(repo, "add", "a")
    git(repo, "commit", "-q", "-m", "by git")
    git(repo, "pack-refs", "--all")  # the branch now lives in packed-refs
    assert not (repo / ".git" / "refs" / "heads" / "main").exists()
    write_file(repo, "a", "2\n")
    mg(repo, "add", "a")
    mg(repo, "commit", "-m", "by minigit")
    assert git_out(repo, "log", "--format=%s") == "by minigit\nby git\n"
    git(repo, "fsck")


def test_identity_precedence(repo, isolated_env, monkeypatch):
    gitdir = repo / ".git"
    for key in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE"):
        monkeypatch.delenv(key)
    sig = identity("author", gitdir, now=1700000000)
    assert (sig.name, sig.email) == (DEFAULT_NAME, DEFAULT_EMAIL)
    assert sig.name == "Jashwanth Neela"

    (isolated_env / ".config" / "git").mkdir(parents=True)
    (isolated_env / ".config" / "git" / "config").write_text("[user]\n\tname = Xdg Person\n")
    assert identity("author", gitdir).name == "Xdg Person"
    (isolated_env / ".gitconfig").write_text('[user]\n\tname = "Global Person"\n\temail = global@example.com\n')
    sig = identity("author", gitdir)
    assert (sig.name, sig.email) == ("Global Person", "global@example.com")
    with open(gitdir / "config", "a") as fh:
        fh.write("[user]\n\temail = local@example.com\n")
    sig = identity("author", gitdir)
    assert (sig.name, sig.email) == ("Global Person", "local@example.com")
    monkeypatch.setenv("GIT_AUTHOR_NAME", "Env Person")
    assert identity("author", gitdir).name == "Env Person"
    monkeypatch.setenv("GIT_AUTHOR_NAME", "Bad <Name>")
    with pytest.raises(GitError, match="invalid identity"):
        identity("author", gitdir)


def test_default_identity_and_local_timezone(repo, monkeypatch):
    for key in list(os.environ):
        if key.startswith(("GIT_AUTHOR", "GIT_COMMITTER")):
            monkeypatch.delenv(key)
    monkeypatch.setenv("TZ", "Asia/Kolkata")
    import time

    time.tzset()
    try:
        write_file(repo, "f", "x\n")
        mg(repo, "add", "f")
        mg(repo, "commit", "-m", "demo")
        raw = git_out(repo, "cat-file", "commit", "HEAD")
        assert f"author Jashwanth Neela <{DEFAULT_EMAIL}> " in raw
        assert raw.split("\n")[1].endswith(" +0530")
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


@pytest.mark.parametrize(
    "text, expected",
    [
        ("1700000000 +0530", (1700000000, "+0530")),
        ("@1700000000 -0800", (1700000000, "-0800")),
        ("1700000000", (1700000000, "+0000")),
        ("2023-11-14T22:13:20Z", (1700000000, "+0000")),
        ("2023-11-15T03:43:20+05:30", (1700000000, "+0530")),
    ],
)
def test_parse_date(text, expected):
    assert parse_date(text) == expected


def test_parse_date_rejects_garbage():
    with pytest.raises(GitError, match="invalid date"):
        parse_date("next tuesday")
    assert parse_date("2023-11-14T22:13:20")[1][0] in "+-"  # naive: local zone


def test_parse_config_syntax():
    cfg = parse_config(
        "# comment\n[User]\n  Name = A ; trailing comment\n  email = \"a@b # not a comment\"\n"
        "[core]\n  bare\n[branch \"main\"]\n  remote = origin\n"
    )
    assert cfg == {
        "user.name": "A",
        "user.email": "a@b # not a comment",
        "core.bare": "true",
        "branch.main.remote": "origin",
    }
    with pytest.raises(GitError):
        parse_config("key = value\n")
    with pytest.raises(GitError):
        parse_config("[broken\n")


def test_revision_parsing(repo):
    shas = []
    for i in range(3):
        write_file(repo, "f", f"{i}\n")
        mg(repo, "add", "f")
        mg(repo, "commit", "-m", f"c{i}")
        shas.append(git_out(repo, "rev-parse", "HEAD").strip())
    r = Repository(repo.resolve())
    assert refs.resolve_revision(r, "HEAD") == shas[2]
    assert refs.resolve_revision(r, "@") == shas[2]
    assert refs.resolve_revision(r, "main~2") == shas[0]
    assert refs.resolve_revision(r, "HEAD^^") == shas[0]
    assert refs.resolve_revision(r, "HEAD^0") == shas[2]
    assert refs.resolve_revision(r, "refs/heads/main^") == shas[1]
    assert refs.resolve_revision(r, shas[1][:6]) == shas[1]
    assert mg(repo, "cat-file", "-t", "HEAD").text == "commit\n"
    assert mg(repo, "cat-file", "-p", "HEAD~1").out == git(repo, "cat-file", "-p", "HEAD~1").stdout
    for bad in ("HEAD~5", "HEAD^2", "nope"):
        with pytest.raises(GitError):
            refs.resolve_revision(r, bad)
    tree = git_out(repo, "rev-parse", "HEAD^{tree}").strip()
    with pytest.raises(GitError, match="not a commit"):
        refs.resolve_revision(r, tree[:8] + "^")
    with pytest.raises(GitError, match="not a commit"):
        refs.resolve_commit(r, tree)
    r2 = mg(repo, "rev-parse", "--abbrev-ref", "main", "HEAD")
    assert r2.text == "main\nmain\n"


def test_unborn_head_and_ref_helpers(repo):
    r = Repository(repo.resolve())
    assert refs.head_commit(r) is None
    with pytest.raises(GitError, match="unknown revision"):
        refs.resolve_revision(r, "HEAD")
    with pytest.raises(GitError):
        refs.resolve_revision(r, "main")
    refs.update_ref(r, "refs/heads/x", "a" * 40)
    (repo / ".git" / "refs" / "heads" / "y.lock").write_text("")
    assert refs.branches(r) == {"x": "a" * 40}
    (repo / ".git" / "refs" / "heads" / "x.lock").write_text("")
    with pytest.raises(GitError, match="cannot lock ref"):
        refs.update_ref(r, "refs/heads/x", "b" * 40)
    refs.update_ref(r, "refs/loop", "ref: refs/loop")
    with pytest.raises(GitError, match="loop"):
        refs.resolve_ref(r, "refs/loop")
    (repo / ".git" / "packed-refs").write_text(f"# pack-refs with: peeled\n{'c' * 40} refs/heads/packed\n^{'d' * 40}\n")
    assert refs.branches(r)["packed"] == "c" * 40
    refs.delete_ref(r, "refs/heads/packed")
    refs.delete_ref(r, "refs/heads/x")
    assert "packed" not in refs.branches(r) and "x" not in refs.branches(r)


@pytest.mark.parametrize("name", ["", "HEAD", "-x", "a..b", "a b", "a~1", "x.lock", "a/", "a//b", "a@{1}", "a/.b", "end."])
def test_invalid_branch_names(name):
    with pytest.raises(GitError, match="not a valid branch name"):
        refs.check_branch_name(name)


@pytest.mark.parametrize("name", ["feature", "feature/login", "fix-123", "v1.0", "日本"])
def test_valid_branch_names(name):
    refs.check_branch_name(name)
