"""log and status, with real git's output as the expected answer."""

import os

import pytest
from helpers import git, git_out, mg, write_file


def commit(repo, message, when, files=None):
    for path, content in (files or {}).items():
        write_file(repo, path, content)
    mg(repo, "add", ".")
    env = {"GIT_AUTHOR_DATE": f"{when} +0530", "GIT_COMMITTER_DATE": f"{when} +0530"}
    mg(repo, "commit", "-m", message, env=env)
    return git_out(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def history(repo):
    commit(repo, "first commit", 1700000000, {"a.txt": "1\n"})
    commit(repo, "second commit\n\nWith a body\nover two lines.", 1700003600, {"b.txt": "2\n"})
    commit(repo, "third", 1700007200, {"a.txt": "3\n"})
    git(repo, "branch", "feature", "HEAD~1")
    git(repo, "branch", "zz-last")
    git(repo, "tag", "v1.0", "HEAD~2")
    git(repo, "tag", "-a", "v2.0", "-m", "annotated", "HEAD~1")
    return repo


def test_log_matches_git_exactly(history):
    assert mg(history, "log", "--color=never").text == git_out(history, "log", "--decorate=short")


def test_log_oneline_matches_git(history):
    assert mg(history, "log", "--oneline", "--color=never").text == git_out(
        history, "log", "--oneline", "--decorate=short"
    )
    assert mg(history, "log", "--oneline", "--no-decorate", "-n", "2").text == git_out(
        history, "log", "--oneline", "--no-decorate", "-n", "2"
    )


def test_log_from_revision_and_detached(history):
    assert mg(history, "log", "--color=never", "feature").text == git_out(history, "log", "--decorate=short", "feature")
    git(history, "checkout", "-q", "--detach", "HEAD~1")
    assert mg(history, "log", "--oneline", "--color=never").text == git_out(history, "log", "--oneline", "--decorate=short")


def test_log_colors(history):
    out = mg(history, "log", "--oneline", "--color=always").text
    assert "\x1b[33m" in out and "\x1b[1;36mHEAD\x1b[m" in out and "\x1b[1;32mmain\x1b[m" in out
    assert "\x1b[1;33mtag: \x1b[m" in out


def test_log_walks_merges_in_date_order(repo):
    base = commit(repo, "base", 1700000000, {"f": "0\n"})
    left = commit(repo, "left", 1700000100, {"l": "l\n"})
    git(repo, "checkout", "-q", "-b", "side", base)
    right = commit(repo, "right", 1700000200, {"r": "r\n"})
    git(repo, "checkout", "-q", "main")
    git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side",
        env={"GIT_AUTHOR_DATE": "1700000300 +0000", "GIT_COMMITTER_DATE": "1700000300 +0000"})
    out = mg(repo, "log", "--color=never").text
    assert out == git_out(repo, "log", "--decorate=short")
    assert f"Merge: {left[:7]} {right[:7]}" in out


def test_log_on_unborn_branch(repo):
    r = mg(repo, "log", check=False)
    assert r.code == 128 and "does not have any commits yet" in r.err


def porcelain_matches(repo):
    ours = mg(repo, "status", "--porcelain").text
    assert ours == git_out(repo, "status", "--porcelain")
    return ours


def test_status_categories_match_git(repo):
    commit(repo, "base", 1700000000, {
        "modified.txt": "old\n", "deleted.txt": "bye\n", "staged-mod.txt": "s\n",
        "staged-del.txt": "x\n", "both.txt": "1\n", "dir/kept.txt": "k\n", "script.sh": "echo\n",
    })
    write_file(repo, "modified.txt", "new\n")                   # unstaged modify
    (repo / "deleted.txt").unlink()                             # unstaged delete
    write_file(repo, "staged-mod.txt", "s2\n")
    mg(repo, "add", "staged-mod.txt")                           # staged modify
    (repo / "staged-del.txt").unlink()
    mg(repo, "add", "staged-del.txt")                           # staged delete
    write_file(repo, "new-staged.txt", "n\n")
    mg(repo, "add", "new-staged.txt")                           # staged add
    write_file(repo, "both.txt", "2\n")
    mg(repo, "add", "both.txt")
    write_file(repo, "both.txt", "3\n")                         # staged and unstaged
    os.chmod(repo / "script.sh", 0o755)                         # mode change
    write_file(repo, "untracked.txt", "u\n")
    write_file(repo, "newdir/a.txt", "a\n")                     # collapsed to newdir/
    write_file(repo, "newdir/sub/b.txt", "b\n")
    write_file(repo, "dir/untracked-in-tracked-dir.txt", "x\n")
    write_file(repo, "with space.txt", "s\n")
    write_file(repo, "café.txt", "c\n")
    write_file(repo, ".gitignore", "*.log\nignored-dir/\n")
    write_file(repo, "noise.log", "ignored\n")
    write_file(repo, "ignored-dir/x.txt", "ignored\n")
    (repo / "empty-dir").mkdir()
    write_file(repo, "only-ignored/x.log", "ignored\n")

    out = porcelain_matches(repo)
    assert "M  staged-mod.txt\n" in out and " D deleted.txt\n" in out and "MM both.txt\n" in out
    assert "?? newdir/\n" in out and "noise.log" not in out and "empty-dir" not in out
    assert '?? "with space.txt"\n' in out and '?? "caf\\303\\251.txt"\n' in out

    short = mg(repo, "status", "-s", "--color=always").text
    assert "\x1b[32mM\x1b[m\x1b[31mM\x1b[m both.txt" in short


def test_status_unborn_typechange_and_clean(repo):
    assert porcelain_matches(repo) == ""
    write_file(repo, "a", "a\n")
    write_file(repo, "link", "file for now\n")
    mg(repo, "add", ".")
    assert porcelain_matches(repo) == "A  a\nA  link\n"
    (repo / "a").unlink()
    assert porcelain_matches(repo) == "AD a\nA  link\n"
    write_file(repo, "a", "a\n")
    mg(repo, "commit", "-m", "c")
    assert porcelain_matches(repo) == ""
    (repo / "link").unlink()
    os.symlink("a", repo / "link")
    assert porcelain_matches(repo) == " T link\n"
    mg(repo, "add", "link")
    assert porcelain_matches(repo) == "T  link\n"


def test_status_detects_same_size_edit_after_stat_change(repo):
    commit(repo, "c", 1700000000, {"f.txt": "aaaa\n"})
    st = os.stat(repo / "f.txt")
    write_file(repo, "f.txt", "bbbb\n")  # same size
    os.utime(repo / "f.txt", ns=(st.st_atime_ns, st.st_mtime_ns))  # and the same mtime
    assert porcelain_matches(repo) == " M f.txt\n"


def test_status_long_format(repo):
    out = mg(repo, "status").text
    assert out.startswith("On branch main\n\nNo commits yet\n")
    assert out.endswith('nothing to commit (create/copy files and use "minigit add" to track)\n')
    write_file(repo, "u.txt", "u\n")
    assert "nothing added to commit but untracked files present" in mg(repo, "status").text
    mg(repo, "add", "u.txt")
    out = mg(repo, "status", "--color=never").text
    assert "Changes to be committed:\n" in out and "\tnew file:   u.txt\n" in out
    assert "minigit rm --cached" in out
    mg(repo, "commit", "-m", "c")
    assert mg(repo, "status").text == "On branch main\nnothing to commit, working tree clean\n"

    write_file(repo, "u.txt", "changed\n")
    write_file(repo, "sub/new.txt", "n\n")
    out = mg(repo / "sub", "status", "--color=always").text  # paths relative to cwd
    assert "Changes not staged for commit:" in out
    assert "\x1b[31mmodified:   ../u.txt\x1b[m" in out
    assert "\t\x1b[31m./\x1b[m\n" in out  # the untracked cwd itself, as git shows it
    assert 'no changes added to commit' in out
    (repo / "u.txt").unlink()
    assert "minigit add/rm" in mg(repo, "status").text
    mg(repo, "add", "u.txt")
    out = mg(repo, "status", "--color=never").text
    assert "\tdeleted:    u.txt\n" in out and "minigit restore --staged" in out


def test_status_detached_head(repo):
    commit(repo, "c", 1700000000, {"f": "1\n"})
    sha = git_out(repo, "rev-parse", "HEAD").strip()
    git(repo, "checkout", "-q", "--detach")
    assert mg(repo, "status", "--color=never").text.startswith(f"HEAD detached at {sha[:7]}\n")
