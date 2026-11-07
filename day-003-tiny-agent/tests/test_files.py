import pytest

from errors import ToolError
from files import MAX_READ_CHARS, WORKSPACE, list_files, read_file, resolve_in_workspace


@pytest.fixture
def root(tmp_path):
    (tmp_path / "notes.md").write_text("hello notes", encoding="utf-8")
    (tmp_path / "Zeta.txt").write_text("z", encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "a.txt").write_text("nested", encoding="utf-8")
    return tmp_path


def test_list_files_sorted_with_folders_first(root):
    assert list_files(root=root) == "docs/\nnotes.md\nZeta.txt"


def test_list_subfolder(root):
    assert list_files("docs", root=root) == "a.txt"


def test_list_empty_folder(root):
    (root / "empty").mkdir()
    assert list_files("empty", root=root) == "(empty folder)"


def test_list_missing_and_not_a_folder(root):
    with pytest.raises(ToolError, match="No such folder"):
        list_files("nope", root=root)
    with pytest.raises(ToolError, match="Not a folder"):
        list_files("notes.md", root=root)


def test_read_file(root):
    assert read_file("notes.md", root=root) == "hello notes"
    assert read_file("docs/a.txt", root=root) == "nested"


def test_read_missing_and_directory(root):
    with pytest.raises(ToolError, match="No such file"):
        read_file("missing.md", root=root)
    with pytest.raises(ToolError, match="Not a file"):
        read_file("docs", root=root)


def test_read_binary_rejected(root):
    (root / "blob.bin").write_bytes(b"\xff\xfe\x00\x80")
    with pytest.raises(ToolError, match="UTF-8"):
        read_file("blob.bin", root=root)


def test_read_truncates_long_files(root):
    (root / "big.txt").write_text("x" * (MAX_READ_CHARS + 50), encoding="utf-8")
    out = read_file("big.txt", root=root)
    assert out.startswith("x" * MAX_READ_CHARS)
    assert "truncated" in out


@pytest.mark.parametrize(
    "path",
    [
        "../secret.txt",
        "../../etc/passwd",
        "docs/../../secret.txt",
        "docs/..",
        "..\\secret.txt",
        "..",
    ],
)
def test_parent_traversal_rejected(root, path):
    with pytest.raises(ToolError, match="traversal"):
        read_file(path, root=root)
    with pytest.raises(ToolError, match="traversal"):
        list_files(path, root=root)


@pytest.mark.parametrize("path", ["/etc/passwd", "/", "\\windows\\system32", "C:\\Windows\\win.ini", "C:/x"])
def test_absolute_paths_rejected(root, path):
    with pytest.raises(ToolError, match="Absolute"):
        read_file(path, root=root)
    with pytest.raises(ToolError, match="Absolute"):
        list_files(path, root=root)


def test_absolute_path_to_a_real_file_inside_root_still_rejected(root):
    with pytest.raises(ToolError, match="Absolute"):
        read_file(str(root / "notes.md"), root=root)


def test_symlink_escaping_workspace_rejected(root, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "secret.txt").write_text("top secret", encoding="utf-8")
    try:
        (root / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks not supported here")
    with pytest.raises(ToolError, match="outside"):
        read_file("link/secret.txt", root=root)


def test_null_byte_and_non_string_rejected(root):
    with pytest.raises(ToolError):
        read_file("a\x00b", root=root)
    with pytest.raises(ToolError):
        read_file(123, root=root)


def test_blank_path_means_workspace_root(root):
    assert resolve_in_workspace("", root=root) == root.resolve()
    assert resolve_in_workspace(".", root=root) == root.resolve()


def test_default_workspace_is_the_sample_folder():
    assert "notes.md" in list_files()
    assert "Detroit" in read_file("trip-plan.md")
    assert WORKSPACE.name == "workspace"
