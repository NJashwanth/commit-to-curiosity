""".gitignore handling, compared with what real git decides for the same tree."""

import pytest
from helpers import git, git_out, mg, write_file

from minigit.ignore import IgnoreMatcher, glob_to_regex, parse_line

FILES = [
    "app.py", "debug.log", "logs/today.log", "logs/keep.me",
    "build/out.o", "src/build/gen.c", "src/main.c", "src/main.o",
    "docs/a.md", "docs/secret/plan.md", "notes.tmp", "important.tmp",
    "deep/a/b/c/cache.bin", "deep/a/x/cache.bin", "root-only.txt", "nested/root-only.txt",
    "space name.txt", "trailing", "#hash.txt", "Q1.csv", "Qx.csv", "vendor/lib/x.js",
    "vendor/keep/y.js", "sub/.gitignore", "sub/local.dat", "sub/inner/local.dat", "sub/other.txt",
]

GITIGNORE = """\
# comments and blank lines are skipped

*.log
!logs/keep.me
build/
*.o
docs/secret/
*.tmp
!important.tmp
deep/**/cache.bin
/root-only.txt
\\#hash.txt
Q[0-9].csv
vendor/*
!vendor/keep/
trailing\\
"""


def build(root):
    for f in FILES:
        write_file(root, f, f"{f}\n")
    write_file(root, ".gitignore", GITIGNORE)
    write_file(root, "sub/.gitignore", "*.dat\n!inner/local.dat\n")


def test_add_dot_matches_real_git(tmp_path):
    ours, theirs = tmp_path / "ours", tmp_path / "theirs"
    ours.mkdir()
    theirs.mkdir()
    mg(ours, "init")
    git(theirs, "init", "-q")
    build(ours)
    build(theirs)
    mg(ours, "add", ".")
    git(theirs, "add", ".")
    assert mg(ours, "ls-files").text == git_out(theirs, "ls-files")
    tracked = mg(ours, "ls-files").text.splitlines()
    assert "logs/keep.me" in tracked and "logs/today.log" not in tracked
    assert "vendor/keep/y.js" in tracked and "vendor/lib/x.js" not in tracked
    assert "important.tmp" in tracked and "notes.tmp" not in tracked
    assert "src/build/gen.c" not in tracked and "nested/root-only.txt" in tracked
    assert "sub/inner/local.dat" in tracked and "sub/local.dat" not in tracked


def test_matcher_agrees_with_git_check_ignore(tmp_path):
    root = tmp_path / "r"
    root.mkdir()
    git(root, "init", "-q")
    build(root)
    matcher = IgnoreMatcher(root)
    proc = git(root, "check-ignore", "--no-index", "--stdin", stdin="\n".join(FILES).encode(), check=False)
    git_ignored = set(proc.stdout.decode().splitlines())
    ours = {f for f in FILES if matcher.is_ignored(f)}
    # check-ignore does not apply the "ignored parent directory" rule, so compare
    # only paths whose parents git does not exclude.
    for f in FILES:
        if not any(matcher.is_ignored("/".join(f.split("/")[:i]), True) for i in range(1, f.count("/") + 1)):
            assert (f in ours) == (f in git_ignored), f


def test_explicitly_adding_an_ignored_file(repo):
    write_file(repo, ".gitignore", "*.log\nbuild/\n")
    write_file(repo, "x.log", "x\n")
    write_file(repo, "ok.txt", "ok\n")
    write_file(repo, "build/a.o", "o\n")
    r = mg(repo, "add", "ok.txt", "x.log", "build", check=False)
    assert r.code == 1
    assert "The following paths are ignored by one of your .gitignore files:\nx.log\nbuild\n" in r.err
    assert "hint: Use -f" in r.err
    assert mg(repo, "ls-files").text == "ok.txt\n"
    mg(repo, "add", "-f", "x.log")
    assert "x.log" in mg(repo, "ls-files").text
    # once tracked, an ignored file keeps being updated by `add .`
    write_file(repo, "x.log", "changed\n")
    mg(repo, "add", ".")
    assert git_out(repo, "diff", "--name-only") == ""


def test_info_exclude_is_respected(repo):
    (repo / ".git" / "info" / "exclude").write_text("secret.txt\n")
    write_file(repo, "secret.txt", "s\n")
    write_file(repo, "public.txt", "p\n")
    mg(repo, "add", ".")
    assert mg(repo, "ls-files").text == "public.txt\n"


@pytest.mark.parametrize(
    "glob, path, expected",
    [
        ("*.c", "main.c", True),
        ("*.c", "dir/main.c", False),  # regex only; basename matching happens in Rule
        ("a/**/b", "a/b", True),
        ("a/**/b", "a/x/y/b", True),
        ("**/foo", "x/y/foo", True),
        ("abc/**", "abc/d/e", True),
        ("[!a]x", "bx", True),
        ("[!a]x", "ax", False),
        ("[a-c]?", "bz", True),
        ("[unclosed", "[unclosed", True),
        ("f\\*", "f*", True),
        ("a**b", "axxb", True),
    ],
)
def test_glob_translation(glob, path, expected):
    import re

    assert bool(re.fullmatch(glob_to_regex(glob), path)) is expected


def test_parse_line_edge_cases():
    assert parse_line("", "") is None
    assert parse_line("# comment", "") is None
    assert parse_line("/", "") is None
    assert parse_line("\\#x", "").pattern == "#x"
    assert parse_line("\\!x", "").pattern == "!x"
    rule = parse_line("!/build/", "sub")
    assert rule.negate and rule.dir_only and rule.anchored and rule.pattern == "build"
    assert rule.matches("sub/build", True) and not rule.matches("build", True)
    assert not rule.matches("sub/build", False)
