import numpy as np
import pytest

import dataset as ds
import synthetic
from conftest import idx_images


def small_synthetic(font_paths, seed=0, **kw):
    return ds.load_dataset("synthetic", seed=seed, n_synthetic=(300, 100), font_paths=font_paths, **kw)


def test_synthetic_shapes_ranges_and_source(font_paths):
    d = small_synthetic(font_paths)
    assert d.source == ds.SOURCE_SYNTHETIC == d.info["name"]
    assert d.x_train.shape == (270, 28, 28) and d.x_val.shape == (30, 28, 28) and d.x_test.shape == (100, 28, 28)
    assert d.y_train.shape == (270,) and d.y_val.shape == (30,) and d.y_test.shape == (100,)
    for x in (d.x_train, d.x_val, d.x_test):
        assert x.dtype == np.float32 and 0.0 <= x.min() and x.max() <= 1.0
    for y in (d.y_train, d.y_val, d.y_test):
        assert y.dtype == np.int64 and y.min() >= 0 and y.max() <= 9
    assert d.info["train"] == 270 and d.info["val"] == 30 and d.info["test"] == 100


def test_same_seed_gives_identical_data_and_another_seed_does_not(font_paths):
    a, b, c = small_synthetic(font_paths, 4), small_synthetic(font_paths, 4), small_synthetic(font_paths, 5)
    for name in ("x_train", "y_train", "x_val", "y_val", "x_test", "y_test"):
        assert np.array_equal(getattr(a, name), getattr(b, name)), name
    assert not np.array_equal(a.x_train, c.x_train)


def test_normalization_is_the_mnist_formula_and_invertible():
    x = np.array([[0.0, 1.0, ds.MNIST_MEAN]], dtype=np.float32)
    n = ds.normalize(x)
    assert n.dtype == np.float32
    assert n[0, 0] == pytest.approx(-0.1307 / 0.3081, abs=1e-6)
    assert n[0, 1] == pytest.approx((1 - 0.1307) / 0.3081, abs=1e-6)
    assert n[0, 2] == pytest.approx(0.0, abs=1e-6)
    assert np.allclose(ds.denormalize(n), x, atol=1e-6)


def test_normalized_batches_are_roughly_zero_mean_unit_variance_for_mnist_like_images(font_paths):
    x = small_synthetic(font_paths).x_train
    n = ds.normalize(x)
    # synthetic digits are ink-heavier than MNIST, so only a loose check: centered and not exploding
    assert -1.0 < n.mean() < 1.5 and 0.5 < n.std() < 2.5


def test_split_is_a_seeded_disjoint_partition():
    x = np.arange(100, dtype=np.float32).reshape(100, 1, 1) * np.ones((1, 28, 28), dtype=np.float32)
    y = np.arange(100) % 10
    xt, yt, xv, yv = ds.split_train_val(x, y, 0.2, seed=1)
    assert len(xt) == 80 and len(xv) == 20
    ids_t, ids_v = set(xt[:, 0, 0]), set(xv[:, 0, 0])
    assert not ids_t & ids_v and len(ids_t | ids_v) == 100
    again = ds.split_train_val(x, y, 0.2, seed=1)
    assert np.array_equal(again[2], xv)
    assert not np.array_equal(ds.split_train_val(x, y, 0.2, seed=2)[2], xv)
    with pytest.raises(ValueError):
        ds.split_train_val(x, y, 1.5, seed=0)


def test_mnist_source_is_used_when_the_download_works(tmp_path, fake_mnist):
    d = ds.load_dataset("mnist", data_dir=tmp_path, fetcher=fake_mnist, verify=False, val_fraction=0.25)
    assert d.source == ds.SOURCE_MNIST
    assert d.x_train.shape == (45, 28, 28) and d.x_val.shape == (15, 28, 28) and d.x_test.shape == (20, 28, 28)
    assert d.x_train.dtype == np.float32 and d.x_train.max() <= 1.0
    assert d.info["mirror"].startswith("https://raw.githubusercontent.com/")
    # test split is the official test set, untouched and in order
    assert np.allclose(d.x_test, fake_mnist.imgs_te / 255.0)


def test_auto_falls_back_to_synthetic_and_records_why(tmp_path, font_paths, capsys):
    def blocked(url):
        raise OSError("Tunnel connection failed: 403 Forbidden")

    d = ds.load_dataset("auto", data_dir=tmp_path, fetcher=blocked, n_synthetic=(200, 50), font_paths=font_paths)
    assert d.source == ds.SOURCE_SYNTHETIC
    assert "403 Forbidden" in d.info["fallback_reason"]
    assert "falling back" in capsys.readouterr().err


def test_auto_prefers_mnist_when_available(tmp_path, fake_mnist):
    d = ds.load_dataset("auto", data_dir=tmp_path, fetcher=fake_mnist, verify=False)
    assert d.source == ds.SOURCE_MNIST and "fallback_reason" not in d.info


def test_explicit_mnist_does_not_silently_fall_back(tmp_path):
    def blocked(url):
        raise OSError("blocked")

    with pytest.raises(OSError):
        ds.load_dataset("mnist", data_dir=tmp_path, fetcher=blocked)


def test_unknown_source_is_rejected():
    with pytest.raises(ValueError, match="unknown source"):
        ds.load_dataset("cifar")
