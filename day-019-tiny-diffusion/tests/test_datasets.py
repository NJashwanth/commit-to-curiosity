import numpy as np
import pytest
import torch

from datasets import DATASETS, jn_glyph, make_dataset


@pytest.mark.parametrize("name", DATASETS)
def test_shape_and_dtype(name):
    x = make_dataset(name, n=300, seed=1)
    assert x.shape == (300, 2)
    assert x.dtype == torch.float32
    assert torch.isfinite(x).all()


@pytest.mark.parametrize("name", DATASETS)
def test_deterministic_for_same_seed(name):
    assert torch.equal(make_dataset(name, 200, seed=5), make_dataset(name, 200, seed=5))


@pytest.mark.parametrize("name", DATASETS)
def test_different_seed_differs(name):
    assert not torch.equal(make_dataset(name, 200, seed=1), make_dataset(name, 200, seed=2))


@pytest.mark.parametrize("name", DATASETS)
def test_normalized(name):
    x = make_dataset(name, 4000, seed=0)
    assert x.mean(dim=0).abs().max() < 0.1
    assert abs(x.std().item() - 1.0) < 0.1
    assert x.abs().max() < 5.0


def test_unknown_dataset_and_bad_n():
    with pytest.raises(ValueError):
        make_dataset("nope")
    with pytest.raises(ValueError):
        make_dataset("moons", n=0)


def test_odd_n_is_respected():
    assert make_dataset("moons", 7).shape == (7, 2)
    assert make_dataset("spiral", 9).shape == (9, 2)


def test_jn_points_fall_inside_glyph_mask():
    mask, centre, scale = jn_glyph()
    pts = make_dataset("jn", 1500, seed=3).numpy()
    col = np.floor(pts[:, 0] * scale + centre[0]).astype(int)
    row = np.floor(-pts[:, 1] * scale + centre[1]).astype(int)
    assert (col >= 0).all() and (col < mask.shape[1]).all()
    assert (row >= 0).all() and (row < mask.shape[0]).all()
    assert mask[row, col].all()


def test_jn_glyph_has_two_letters():
    mask, _, _ = jn_glyph()
    cols = np.nonzero(mask.any(axis=0))[0]
    gaps = np.diff(cols) > 1  # an empty column band separates J from N
    assert mask.sum() > 1000
    assert gaps.any()
