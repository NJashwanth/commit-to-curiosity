import gzip
import struct

import numpy as np
import pytest

import mnist
from conftest import idx_images, idx_labels


def test_parse_idx_labels_and_images():
    labels = np.array([3, 1, 4, 1, 5], dtype=np.uint8)
    assert np.array_equal(mnist.parse_idx(idx_labels(labels)), labels)
    imgs = np.arange(2 * 28 * 28).reshape(2, 28, 28) % 256
    out = mnist.parse_idx(idx_images(imgs))
    assert out.shape == (2, 28, 28) and out.dtype == np.uint8
    assert np.array_equal(out, imgs)


@pytest.mark.parametrize(
    "blob, message",
    [
        (b"\x00\x00", "too short"),
        (struct.pack(">II", 0x1234, 1) + b"\x00", "unknown IDX magic"),
        (struct.pack(">II", mnist.LABEL_MAGIC, 5) + b"\x00\x01", "labels"),
        (struct.pack(">IIII", mnist.IMAGE_MAGIC, 2, 28, 28) + b"\x00" * 10, "images"),
    ],
)
def test_parse_idx_rejects_bad_data(blob, message):
    with pytest.raises(ValueError, match=message):
        mnist.parse_idx(blob)


def test_load_mnist_downloads_once_then_uses_the_cache(tmp_path, fake_mnist):
    x_tr, y_tr, x_te, y_te = mnist.load_mnist(tmp_path, verify=False, fetcher=fake_mnist)
    assert x_tr.shape == (60, 28, 28) and y_tr.shape == (60,)
    assert x_te.shape == (20, 28, 28) and y_te.shape == (20,)
    assert np.array_equal(x_tr, fake_mnist.imgs_tr)
    assert len(fake_mnist.calls) == 4
    assert all(u.startswith(mnist.MIRROR) for u in fake_mnist.calls)

    mnist.load_mnist(tmp_path, verify=False, fetcher=fake_mnist)  # second load: nothing to fetch
    assert len(fake_mnist.calls) == 4


def test_checksum_mismatch_is_rejected_and_not_cached(tmp_path, fake_mnist):
    with pytest.raises(ValueError, match="checksum mismatch"):
        mnist.ensure_files(tmp_path, verify=True, fetcher=fake_mnist)
    assert list(tmp_path.glob("*.gz")) == []


def test_a_proxy_error_page_is_not_mistaken_for_data(tmp_path):
    with pytest.raises(OSError):
        mnist.ensure_files(tmp_path, verify=False, fetcher=lambda url: b"<html>403 Forbidden</html>")


def test_a_corrupt_cached_file_is_downloaded_again(tmp_path, fake_mnist, monkeypatch):
    # make the fake archives the "official" ones, then plant a corrupt copy of one of them
    monkeypatch.setattr(mnist, "FILES", {name: mnist._md5(blob) for name, blob in fake_mnist.blobs.items()})
    (tmp_path / "train-images-idx3-ubyte.gz").write_bytes(b"garbage")
    mnist.ensure_files(tmp_path, verify=True, fetcher=fake_mnist)
    assert len(fake_mnist.calls) == 4
    assert (tmp_path / "train-images-idx3-ubyte.gz").read_bytes() == fake_mnist.blobs["train-images-idx3-ubyte.gz"]
    mnist.ensure_files(tmp_path, verify=True, fetcher=fake_mnist)  # now everything verifies from the cache
    assert len(fake_mnist.calls) == 4
