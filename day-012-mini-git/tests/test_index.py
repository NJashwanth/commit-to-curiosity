"""The index file and `add`, with real git reading what mini-git writes and vice versa."""

import os
import struct

import pytest
from helpers import git, git_out, mg, write_file

from minigit.errors import GitError
from minigit.index import Index, IndexEntry, read_index, write_index

UNICODE_NAME = "café ☕/日本語.txt"


def make_mixed_tree(root):
    """Nested dirs, an empty file, binary data, an executable, unicode names and a symlink."""
    write_file(root, "README.md", "# hello\n")
    write_file(root, "empty.txt", b"")
    write_file(root, "bin/data.bin", bytes(range(256)) + b"\0\0\xff")
    write_file(root, "bin/run.sh", "#!/bin/sh\necho hi\n", executable=True)
    write_file(root, "src/pkg/deep/module.py", "x = 1\n")
    write_file(root, "src/pkg/__init__.py", b"")
    write_file(root, UNICODE_NAME, "konnichiwa\n")
    os.symlink("README.md", root / "link-to-readme")


def test_git_accepts_index_written_by_minigit(repo):
    make_mixed_tree(repo)
    mg(repo, "add", ".")
    assert mg(repo, "ls-files", "--stage").out == git(repo, "ls-files", "--stage").stdout
    # Every file is staged as new, and nothing differs between index and working tree.
    porcelain = git(repo, "status", "--porcelain", "-z").stdout.decode()
    assert sorted(porcelain.rstrip("\0").split("\0")) == sorted(
        f"A  {p}" for p in [
            "README.md", "bin/data.bin", "bin/run.sh", "empty.txt", "link-to-readme",
            "src/pkg/__init__.py", "src/pkg/deep/module.py", UNICODE_NAME,
        ]
    )
    git(repo, "diff", "--quiet")  # index matches the working tree
    stage = git_out(repo, "ls-files", "--stage")
    assert "100755 " in stage.split("bin/run.sh")[0].splitlines()[-1]
    assert any(line.startswith("120000 ") and line.endswith("link-to-readme") for line in stage.splitlines())
    assert "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tempty.txt" in stage
    git(repo, "fsck", "--strict")


def test_minigit_reads_index_written_by_git(repo):
    make_mixed_tree(repo)
    git(repo, "add", ".")
    assert mg(repo, "ls-files", "--stage").out == git(repo, "ls-files", "--stage").stdout
    assert mg(repo, "ls-files").out == git(repo, "ls-files").stdout


def test_index_round_trips_byte_for_byte(repo):
    make_mixed_tree(repo)
    git(repo, "add", ".")
    data = (repo / ".git" / "index").read_bytes()
    assert Index.parse(data).serialize() == data


def test_index_with_tree_extension_from_git_commit(repo):
    write_file(repo, "a/b.txt", "b\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "c")
    raw = (repo / ".git" / "index").read_bytes()
    assert b"TREE" in raw  # git wrote its cache-tree extension
    assert mg(repo, "ls-files").text == "a/b.txt\n"
    write_file(repo, "a/c.txt", "c\n")
    mg(repo, "add", "a")  # we rewrite without the (now stale) extension
    assert b"TREE" not in (repo / ".git" / "index").read_bytes()
    assert git_out(repo, "status", "--porcelain") == "A  a/c.txt\n"


def test_entry_padding_is_always_a_multiple_of_eight():
    for n in range(1, 40):
        packed = IndexEntry("x" * n, "0" * 40).pack()
        assert len(packed) % 8 == 0
        assert packed.endswith(b"\0")
        assert 1 <= len(packed) - 62 - n <= 8


def test_long_paths_set_the_name_length_mask(repo):
    long_name = "d/" * 2100 + "f.txt"
    entry = IndexEntry(long_name, "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
    index = Index({long_name: entry})
    data = index.serialize()
    flags = struct.unpack_from(">H", data, 12 + 60)[0]
    assert flags & 0x0FFF == 0x0FFF
    assert Index.parse(data).get(long_name).sha == entry.sha


def test_index_errors(repo, tmp_path):
    write_file(repo, "a.txt", "a\n")
    mg(repo, "add", "a.txt")
    path = repo / ".git" / "index"
    good = path.read_bytes()

    path.write_bytes(good[:-1] + bytes([good[-1] ^ 1]))
    r = mg(repo, "ls-files", check=False)
    assert r.code == 128 and "bad checksum" in r.err

    with pytest.raises(GitError, match="bad signature"):
        body = b"XXXX" + good[4:-20]
        Index.parse(body + __import__("hashlib").sha1(body).digest())
    with pytest.raises(GitError, match="too short"):
        Index.parse(b"DIRC")

    path.write_bytes(good)
    git(repo, "update-index", "--index-version", "4")
    r = mg(repo, "ls-files", check=False)
    assert "version 4 is not supported" in r.err

    git(repo, "update-index", "--index-version", "2")
    (repo / ".git" / "index.lock").write_bytes(b"")
    r = mg(repo, "add", "a.txt", check=False)
    assert r.code == 128 and "index.lock': File exists" in r.err


def test_index_with_zero_checksum_and_required_extension():
    entry = IndexEntry("a", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
    body = Index({"a": entry}).serialize()[:-20]
    assert Index.parse(body + b"\0" * 20).get("a").sha == entry.sha  # index.skipHash
    import hashlib

    with_ext = body + b"link" + struct.pack(">I", 4) + b"\0\0\0\0"
    with pytest.raises(GitError, match="required extension 'link'"):
        Index.parse(with_ext + hashlib.sha1(with_ext).digest())
    optional = body + b"UNTR" + struct.pack(">I", 2) + b"xx"
    assert len(Index.parse(optional + hashlib.sha1(optional).digest())) == 1


def test_conflicted_entries_are_refused(repo):
    entry = IndexEntry("a", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", flags=2 << 12)
    with pytest.raises(GitError, match="merge conflicts"):
        Index.parse(Index({"a": entry}).serialize())


def test_add_stages_deletions_and_updates(repo):
    write_file(repo, "keep.txt", "1\n")
    write_file(repo, "dir/gone.txt", "2\n")
    mg(repo, "add", ".")
    (repo / "dir" / "gone.txt").unlink()
    write_file(repo, "keep.txt", "changed\n")
    mg(repo, "add", ".")
    assert mg(repo, "ls-files").text == "keep.txt\n"
    assert git_out(repo, "ls-files", "--stage").split()[1] == git_out(repo, "hash-object", "keep.txt").strip()
    # A removed file can be named explicitly too.
    write_file(repo, "x.txt", "x\n")
    mg(repo, "add", "x.txt")
    (repo / "x.txt").unlink()
    mg(repo, "add", "x.txt")
    assert "x.txt" not in mg(repo, "ls-files").text


def test_add_from_subdirectory_and_errors(repo):
    write_file(repo, "sub/a.txt", "a\n")
    write_file(repo, "top.txt", "t\n")
    mg(repo / "sub", "add", "a.txt", "../top.txt")
    assert mg(repo, "ls-files").text == "sub/a.txt\ntop.txt\n"
    r = mg(repo, "add", "nope.txt", check=False)
    assert r.code == 128 and "pathspec 'nope.txt' did not match any files" in r.err
    r = mg(repo, "add", check=False)
    assert r.code == 1 and "Nothing specified" in r.err
    r = mg(repo, "add", "../outside", check=False)
    assert r.code == 128 and "outside repository" in r.err


def test_add_all_and_executable_bit_change(repo):
    write_file(repo, "s.sh", "echo\n")
    mg(repo, "add", "-A")
    assert git_out(repo, "ls-files", "--stage").startswith("100644")
    os.chmod(repo / "s.sh", 0o755)
    mg(repo, "add", "s.sh")
    assert git_out(repo, "ls-files", "--stage").startswith("100755")
    git(repo, "diff", "--quiet")


def test_file_replacing_directory_in_index(repo):
    write_file(repo, "thing/inner.txt", "i\n")
    mg(repo, "add", ".")
    (repo / "thing" / "inner.txt").unlink()
    (repo / "thing").rmdir()
    write_file(repo, "thing", "now a file\n")
    mg(repo, "add", ".")
    assert mg(repo, "ls-files").text == "thing\n"
    index = read_index(repo / ".git" / "index")
    index.add(IndexEntry("thing/x", index.get("thing").sha))
    assert list(index.entries) == ["thing/x"]


def test_write_and_read_index_api(tmp_path):
    path = tmp_path / "index"
    assert len(read_index(path)) == 0
    index = Index()
    index.add(IndexEntry("b", "1" * 40))
    index.add(IndexEntry("a", "2" * 40, mode=0o100755))
    write_index(index, path)
    back = read_index(path)
    assert [e.path for e in back] == ["a", "b"] and "a" in back
    assert back.get("a").mode_str == "100755"
    back.remove("a")
    assert len(back) == 1
