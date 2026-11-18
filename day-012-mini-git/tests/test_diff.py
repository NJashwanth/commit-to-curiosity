"""diff and diff --staged, compared with real git's output and checked with git apply."""

import os
import random

from helpers import git, git_out, mg, write_file

from minigit.diff import Side, file_diff, hunks, is_binary

PYTHON_FILE = "".join(
    [
        "import os\n",
        "\n",
        "\n",
        "def first():\n",
        *[f"    line_{i} = {i}\n" for i in range(12)],
        "    return line_0\n",
        "\n",
        "\n",
        "class Second:\n",
        *[f"    attr_{i} = {i}\n" for i in range(12)],
    ]
)


def base_repo(repo, files):
    for path, content in files.items():
        write_file(repo, path, content)
    mg(repo, "add", ".")
    mg(repo, "commit", "-m", "base")


def same_as_git(repo, *extra):
    ours = mg(repo, "diff", "--color=never", *extra).out
    theirs = git(repo, "diff", *extra).stdout
    assert ours == theirs, f"\n--- minigit ---\n{ours.decode()}\n--- git ---\n{theirs.decode()}"
    return ours.decode("utf-8", "surrogateescape")


def test_modified_lines_with_function_context(repo):
    base_repo(repo, {"code.py": PYTHON_FILE})
    edited = PYTHON_FILE.replace("line_9 = 9", "line_9 = 99").replace("attr_10 = 10", "attr_10 = 1000")
    edited = edited.replace("import os\n", "import os\nimport sys\n")
    write_file(repo, "code.py", edited)
    out = same_as_git(repo)
    assert "@@ -11,7 +12,7 @@ def first():" in out
    assert "@@ -28,5 +29,5 @@ class Second:" in out


def test_unstaged_edge_cases_match_git(repo):
    base_repo(repo, {
        "plain.txt": "a\nb\nc\n",
        "no-eol.txt": "one\ntwo",
        "gets-eol.txt": "x",
        "to-empty.txt": "content\n",
        "gone.txt": "delete me\n",
        "data.bin": b"\0\1\2",
        "mode.sh": "echo\n",
        "both.sh": "echo 1\n",
        "café dir/naïve file.txt": "unicode\n",
    })
    write_file(repo, "plain.txt", "a\nB\nc\nd\n")
    write_file(repo, "no-eol.txt", "one\nTWO")
    write_file(repo, "gets-eol.txt", "x\n")
    write_file(repo, "to-empty.txt", "")
    (repo / "gone.txt").unlink()
    write_file(repo, "data.bin", b"\0\1\3")
    os.chmod(repo / "mode.sh", 0o755)
    write_file(repo, "both.sh", "echo 2\n", executable=True)
    write_file(repo, "café dir/naïve file.txt", "unicode!\n")
    out = same_as_git(repo)
    assert "\\ No newline at end of file" in out
    assert "Binary files a/data.bin and b/data.bin differ" in out
    assert "deleted file mode 100644" in out and "old mode 100644\nnew mode 100755\n" in out
    assert same_as_git(repo, "plain.txt") == git_out(repo, "diff", "plain.txt")


def test_staged_diff_matches_git(repo):
    base_repo(repo, {"keep.txt": "1\n2\n3\n", "remove.txt": "bye\n", "bin.dat": b"\0old"})
    write_file(repo, "keep.txt", "1\ntwo\n3\n")
    write_file(repo, "new.txt", "hello\nworld\n")
    write_file(repo, "empty.txt", b"")
    write_file(repo, "newbin.dat", b"\0\0\0")
    os.symlink("keep.txt", repo / "link")
    (repo / "remove.txt").unlink()
    (repo / "bin.dat").unlink()
    mg(repo, "add", ".")
    out = same_as_git(repo, "--staged")
    assert "new file mode 100644\nindex 0000000..e69de29\n" in out  # empty file: no hunks
    assert "Binary files /dev/null and b/newbin.dat differ" in out
    assert "new file mode 120000" in out
    assert "+++ /dev/null" in out
    assert same_as_git(repo) == ""  # nothing unstaged
    assert mg(repo, "diff", "--cached", "--color=never").out == git(repo, "diff", "--cached").stdout


def test_staged_diff_on_unborn_branch(repo):
    write_file(repo, "a.txt", "a\n")
    mg(repo, "add", "a.txt")
    out = same_as_git(repo, "--staged")
    assert out.startswith("diff --git a/a.txt b/a.txt\nnew file mode 100644\n")


def test_colors(repo):
    base_repo(repo, {"f.txt": "old\n"})
    write_file(repo, "f.txt", "new\n")
    out = mg(repo, "diff", "--color=always").text
    assert out == git_out(repo, "-c", "color.diff=always", "diff")
    assert "\x1b[1mdiff --git a/f.txt b/f.txt\x1b[m" in out
    assert "\x1b[36m@@ -1 +1 @@\x1b[m" in out
    assert "\x1b[31m-old\x1b[m" in out and "\x1b[32m+\x1b[m\x1b[32mnew\x1b[m" in out


def test_no_changes_means_no_output(repo):
    base_repo(repo, {"f.txt": "same\n"})
    os.utime(repo / "f.txt", (1, 1))  # stat changed, content did not
    assert mg(repo, "diff").out == b""
    assert mg(repo, "diff", "--staged").out == b""


def test_random_edits_round_trip_through_git_apply(repo):
    rng = random.Random(12)
    words = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta"]
    original = {f"f{n}.txt": [rng.choice(words) for _ in range(60)] for n in range(5)}
    base_repo(repo, {name: "\n".join(lines) + "\n" for name, lines in original.items()})
    edited = {}
    for name, lines in original.items():
        lines = list(lines)
        for _ in range(12):
            op, pos = rng.choice("ird"), rng.randrange(len(lines))
            if op == "i":
                lines.insert(pos, rng.choice(words) + "!")
            elif op == "r":
                lines[pos] = lines[pos].upper()
            elif len(lines) > 1:
                del lines[pos]
        edited[name] = "\n".join(lines) + "\n"
        write_file(repo, name, edited[name])
    patch = mg(repo, "diff", "--color=never").out
    git(repo, "checkout", "--", ".")  # back to the committed content
    git(repo, "apply", "--check", "-", stdin=patch)
    git(repo, "apply", "-", stdin=patch)
    for name, content in edited.items():
        assert (repo / name).read_text() == content


def test_diff_module_units():
    assert is_binary(b"a\0b") and not is_binary(b"text")
    [(header, func, body)] = list(hunks(b"a\n", b""))
    assert header == b"@@ -1 +0,0 @@" and func == b"" and body == [("-", b"a\n")]
    old = Side("s", "100644", "a" * 40, b"x\n")
    new = Side("s", "100755", "a" * 40, b"x\n")
    assert file_diff(old, new, lambda s: s[:7]) == b"diff --git a/s b/s\nold mode 100644\nnew mode 100755\n"


def test_long_function_context_is_truncated_like_git(repo):
    body = "".join(f"    step_{i}()\n" for i in range(10))
    base_repo(repo, {"long.py": "def " + "f" * 100 + "():   \n" + body})
    write_file(repo, "long.py", "def " + "f" * 100 + "():   \n" + body.replace("step_9", "STEP_9"))
    out = same_as_git(repo)
    header = next(line for line in out.splitlines() if line.startswith("@@"))
    assert header.endswith(" def " + "f" * 76)  # 80 bytes of context
