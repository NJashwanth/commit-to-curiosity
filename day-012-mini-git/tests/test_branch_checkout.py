"""branch and checkout: switching trees safely, verified against real git."""

import os

import pytest
from helpers import git, git_out, mg, write_file


def commit_all(repo, message):
    mg(repo, "add", ".")
    mg(repo, "commit", "-m", message)
    return git_out(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def two_branches(repo):
    """main: shared.txt, main-only.txt, dir/a.txt.  feature: shared.txt changed,
    feature-only/, run.sh executable, main-only.txt removed."""
    write_file(repo, "shared.txt", "shared v1\n")
    write_file(repo, "main-only.txt", "only on main\n")
    write_file(repo, "dir/a.txt", "a\n")
    write_file(repo, "untouched.txt", "same everywhere\n")
    base = commit_all(repo, "base")
    mg(repo, "checkout", "-b", "feature")
    write_file(repo, "shared.txt", "shared v2\n")
    (repo / "main-only.txt").unlink()
    write_file(repo, "feature-only/deep/f.txt", "f\n")
    write_file(repo, "run.sh", "echo hi\n", executable=True)
    feature = commit_all(repo, "feature work")
    mg(repo, "checkout", "main")
    return repo, base, feature


def assert_clean_like_git(repo):
    assert git_out(repo, "status", "--porcelain") == ""
    assert mg(repo, "status", "--porcelain").text == ""
    git(repo, "diff", "--quiet")


def test_branch_create_and_list(repo):
    write_file(repo, "f", "1\n")
    commit_all(repo, "c1")
    mg(repo, "branch", "feature")
    mg(repo, "branch", "alpha")
    mg(repo, "branch", "nested/topic", "HEAD")
    assert mg(repo, "branch", "--color=never").text == git_out(repo, "branch")
    assert "* \x1b[32mmain\x1b[m" in mg(repo, "branch", "--color=always").text
    assert git_out(repo, "rev-parse", "feature") == git_out(repo, "rev-parse", "main")
    git(repo, "fsck")


def test_branch_errors(repo):
    r = mg(repo, "branch", "x", check=False)
    assert r.code == 128 and "not a valid object name: 'main'" in r.err
    write_file(repo, "f", "1\n")
    commit_all(repo, "c1")
    mg(repo, "branch", "x")
    assert "already exists" in mg(repo, "branch", "x", check=False).err
    assert "not a valid branch name" in mg(repo, "branch", "bad..name", check=False).err
    assert "Not a valid object name" in mg(repo, "branch", "y", "nope", check=False).err
    assert "branch name required" in mg(repo, "branch", "-d", check=False).err


def test_branch_delete(two_branches):
    repo, base, feature = two_branches
    r = mg(repo, "branch", "-d", "feature", check=False)
    assert r.code == 1 and "not fully merged" in r.err
    r = mg(repo, "branch", "-d", "main", check=False)
    assert r.code == 1 and "Cannot delete branch 'main'" in r.err
    assert "not found" in mg(repo, "branch", "-d", "ghost", check=False).err
    mg(repo, "branch", "merged", base)
    assert mg(repo, "branch", "-d", "merged").text == f"Deleted branch merged (was {base[:7]}).\n"
    mg(repo, "branch", "-D", "feature")
    assert git_out(repo, "branch", "--list") == "* main\n"


def test_checkout_switches_files_and_index(two_branches):
    repo, base, feature = two_branches
    assert not (repo / "feature-only").exists() and (repo / "main-only.txt").exists()
    assert mg(repo, "checkout", "feature").text == "Switched to branch 'feature'\n"
    assert (repo / "HEAD").exists() is False and (repo / ".git" / "HEAD").read_text() == "ref: refs/heads/feature\n"
    assert (repo / "shared.txt").read_text() == "shared v2\n"
    assert not (repo / "main-only.txt").exists()
    assert (repo / "feature-only" / "deep" / "f.txt").read_text() == "f\n"
    assert os.stat(repo / "run.sh").st_mode & 0o111
    assert_clean_like_git(repo)
    assert git_out(repo, "ls-files") == git_out(repo, "ls-tree", "-r", "--name-only", "HEAD")

    mg(repo, "checkout", "main")
    assert (repo / "shared.txt").read_text() == "shared v1\n"
    assert (repo / "main-only.txt").read_text() == "only on main\n"
    assert not (repo / "feature-only").exists()  # emptied directories are pruned
    assert not (repo / "run.sh").exists()
    assert_clean_like_git(repo)
    assert mg(repo, "checkout", "main").text == "Already on 'main'\n"


def test_checkout_refuses_to_clobber_unstaged_changes(two_branches):
    repo, _, _ = two_branches
    write_file(repo, "shared.txt", "my precious edit\n")
    r = mg(repo, "checkout", "feature", check=False)
    assert r.code == 1
    assert "Your local changes to the following files would be overwritten by checkout:\n\tshared.txt" in r.err
    assert r.err.rstrip().endswith("Aborting")
    # Nothing moved: same branch, same file, same index.
    assert (repo / ".git" / "HEAD").read_text() == "ref: refs/heads/main\n"
    assert (repo / "shared.txt").read_text() == "my precious edit\n"
    assert not (repo / "feature-only").exists()
    # Real git agrees it must refuse.
    assert git(repo, "checkout", "feature", check=False).returncode != 0


def test_checkout_refuses_staged_changes_and_deletions(two_branches):
    repo, _, _ = two_branches
    write_file(repo, "shared.txt", "staged edit\n")
    mg(repo, "add", "shared.txt")
    assert "shared.txt" in mg(repo, "checkout", "feature", check=False).err
    write_file(repo, "shared.txt", "shared v1\n")
    mg(repo, "add", "shared.txt")
    (repo / "main-only.txt").unlink()  # unstaged deletion of a file feature also deletes is fine
    (repo / "shared.txt").unlink()  # but deleting one that feature changes is not
    r = mg(repo, "checkout", "feature", check=False)
    assert r.code == 1 and "\tshared.txt\n" in r.err and "main-only.txt" not in r.err
    write_file(repo, "shared.txt", "shared v1\n")
    mg(repo, "add", "shared.txt", "main-only.txt")  # stage the removal
    r = mg(repo, "checkout", "feature")
    assert git_out(repo, "status", "--porcelain") == ""


def test_checkout_refuses_to_overwrite_untracked_files(two_branches):
    repo, _, _ = two_branches
    write_file(repo, "run.sh", "my own script\n")
    write_file(repo, "feature-only", "a file where feature needs a directory\n")
    r = mg(repo, "checkout", "feature", check=False)
    assert r.code == 1
    assert "untracked working tree files would be overwritten" in r.err
    assert "\trun.sh\n" in r.err and "\tfeature-only/deep/f.txt\n" in r.err
    assert (repo / "run.sh").read_text() == "my own script\n"
    (repo / "run.sh").unlink()
    (repo / "feature-only").unlink()
    # ignored files are expendable, as in git
    write_file(repo, ".git/info/exclude", "run.sh\n")
    write_file(repo, "run.sh", "ignored scratch\n")
    mg(repo, "checkout", "feature")
    assert (repo / "run.sh").read_text() == "echo hi\n"


def test_checkout_carries_unrelated_changes(two_branches):
    repo, _, _ = two_branches
    write_file(repo, "untouched.txt", "edited but same in both branches\n")
    write_file(repo, "dir/a.txt", "staged edit\n")
    mg(repo, "add", "dir/a.txt")
    write_file(repo, "scratch.txt", "untracked\n")
    mg(repo, "checkout", "feature")
    assert (repo / "untouched.txt").read_text() == "edited but same in both branches\n"
    assert (repo / "scratch.txt").exists()
    porcelain = git_out(repo, "status", "--porcelain")
    assert porcelain == "M  dir/a.txt\n M untouched.txt\n?? scratch.txt\n"
    assert mg(repo, "status", "--porcelain").text == porcelain


def test_checkout_when_index_already_matches_target(two_branches):
    repo, _, _ = two_branches
    write_file(repo, "shared.txt", "shared v2\n")  # the same content feature has
    mg(repo, "add", "shared.txt")
    mg(repo, "checkout", "feature")
    assert_clean_like_git(repo)


def test_checkout_detached_and_back(two_branches):
    repo, base, feature = two_branches
    out = mg(repo, "checkout", feature[:8]).text
    assert "detached HEAD" in out and f"HEAD is now at {feature[:7]} feature work" in out
    assert (repo / ".git" / "HEAD").read_text() == feature + "\n"
    assert git(repo, "symbolic-ref", "-q", "HEAD", check=False).returncode == 1
    assert mg(repo, "branch").text.startswith(f"* (HEAD detached at {feature[:7]})\n")
    write_file(repo, "detached.txt", "d\n")
    commit_all(repo, "on detached head")
    mg(repo, "checkout", "-b", "rescued")
    assert git_out(repo, "log", "--format=%s", "-1", "rescued") == "on detached head\n"
    mg(repo, "checkout", "main")
    assert not (repo / "detached.txt").exists()
    mg(repo, "checkout", "HEAD~0")
    assert_clean_like_git(repo)
    git(repo, "fsck")


def test_checkout_b_from_start_point_and_errors(two_branches):
    repo, base, feature = two_branches
    assert mg(repo, "checkout", "-b", "from-feature", "feature").text == "Switched to a new branch 'from-feature'\n"
    assert (repo / "shared.txt").read_text() == "shared v2\n"
    assert git_out(repo, "rev-parse", "HEAD").strip() == feature
    assert "already exists" in mg(repo, "checkout", "-b", "main", check=False).err
    assert "not a valid branch name" in mg(repo, "checkout", "-b", "bad..name", check=False).err
    assert mg(repo, "checkout", check=False).code == 129
    assert "Not a valid object name" in mg(repo, "checkout", "nowhere", check=False).err


def test_checkout_b_on_unborn_branch(repo):
    assert mg(repo, "checkout", "-b", "trunk").text == "Switched to a new branch 'trunk'\n"
    write_file(repo, "f", "1\n")
    commit_all(repo, "first on trunk")
    assert git_out(repo, "branch") == "* trunk\n"


def test_checkout_symlinks_and_file_directory_swaps(repo):
    write_file(repo, "target.txt", "t\n")
    os.symlink("target.txt", repo / "link")
    write_file(repo, "thing/inside.txt", "dir version\n")
    commit_all(repo, "with dir")
    mg(repo, "checkout", "-b", "swap")
    for p in ("thing/inside.txt",):
        (repo / p).unlink()
    (repo / "thing").rmdir()
    write_file(repo, "thing", "file version\n")
    (repo / "link").unlink()
    write_file(repo, "link", "regular now\n")
    commit_all(repo, "dir became file")
    mg(repo, "checkout", "main")
    assert (repo / "thing" / "inside.txt").read_text() == "dir version\n"
    assert os.readlink(repo / "link") == "target.txt"
    assert_clean_like_git(repo)
    mg(repo, "checkout", "swap")
    assert (repo / "thing").read_text() == "file version\n"
    assert not (repo / "link").is_symlink()
    assert_clean_like_git(repo)


def test_minigit_checkout_of_git_made_branch(repo):
    write_file(repo, "a.txt", "a\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "git base")
    git(repo, "checkout", "-q", "-b", "gitbranch")
    write_file(repo, "b/c.txt", "c\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "git branch work")
    git(repo, "checkout", "-q", "main")
    mg(repo, "checkout", "gitbranch")
    assert (repo / "b" / "c.txt").read_text() == "c\n"
    assert_clean_like_git(repo)


def test_checkout_refuses_staged_removal_of_changed_file(two_branches):
    repo, _, _ = two_branches
    (repo / "shared.txt").unlink()
    mg(repo, "add", "shared.txt")  # stage the removal; feature has a new version
    r = mg(repo, "checkout", "feature", check=False)
    assert r.code == 1 and "\tshared.txt\n" in r.err
    assert git(repo, "checkout", "feature", check=False).returncode != 0
