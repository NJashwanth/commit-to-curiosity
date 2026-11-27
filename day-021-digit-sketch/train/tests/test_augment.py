import numpy as np
import pytest

import augment as aug
from preprocess import mnist_style


@pytest.fixture
def digit():
    img = np.zeros((60, 60))
    img[8:52, 26:34] = 1.0     # a vertical bar, like a "1"
    img[8:16, 18:30] = 1.0
    return mnist_style(img)


@pytest.mark.parametrize("cfg", [aug.LIGHT, aug.HEAVY, aug.AugmentConfig()])
def test_sampled_parameters_stay_within_the_configured_bounds(cfg):
    rng = np.random.default_rng(1)
    for _ in range(3000):
        p = aug.sample_params(rng, cfg)
        assert abs(p.angle_deg) <= cfg.rotation_deg
        assert cfg.scale[0] <= p.scale <= cfg.scale[1]
        assert abs(p.shear_deg) <= cfg.shear_deg
        assert abs(p.shift_x) <= cfg.shift_px and abs(p.shift_y) <= cfg.shift_px
        assert cfg.thickness[0] <= p.thickness <= cfg.thickness[1]
        assert cfg.blur_sigma[0] <= p.blur_sigma <= cfg.blur_sigma[1]
        assert 0.0 <= p.noise_std <= cfg.noise_std


def test_parameters_actually_vary():
    rng = np.random.default_rng(2)
    angles = [aug.sample_params(rng).angle_deg for _ in range(200)]
    assert max(angles) > 10 and min(angles) < -10  # covers both sides of the range


def test_output_is_a_valid_image(digit):
    rng = np.random.default_rng(3)
    for _ in range(100):
        out = aug.augment(digit, rng, aug.HEAVY)
        assert out.shape == (28, 28) and out.dtype == np.float32
        assert out.min() >= 0.0 and out.max() <= 1.0
        assert np.isfinite(out).all()


def test_identity_parameters_without_distortion_leave_the_image_alone(digit):
    cfg = aug.AugmentConfig(elastic_px=0.0)
    out = aug.augment(digit, np.random.default_rng(0), cfg, params=aug.IDENTITY)
    assert np.allclose(out, digit, atol=1e-6)


def test_a_shift_moves_the_ink_by_that_many_pixels():
    img = np.zeros((28, 28))
    img[10, 10] = 1.0
    moved = aug.warp(img, aug.AugmentParams(0, 1, 0, shift_x=3.0, shift_y=-2.0, thickness=0, blur_sigma=0, noise_std=0))
    assert np.unravel_index(moved.argmax(), moved.shape) == (8, 13)


def test_rotation_by_90_degrees_matches_numpy_rot90():
    img = np.zeros((28, 28))
    img[5:20, 12:15] = 1.0
    rotated = aug.warp(img, aug.AugmentParams(90, 1, 0, 0, 0, 0, 0, 0))
    # grid is 28 wide, so rotating about (13.5, 13.5) is exactly a rot90 of the array
    assert np.allclose(rotated, np.rot90(img, k=-1), atol=1e-9) or np.allclose(rotated, np.rot90(img, k=1), atol=1e-9)


def test_elastic_displacement_is_bounded_and_smooth():
    dy, dx = aug.elastic_field(np.random.default_rng(0), 28, sigma=3.0, max_px=1.5)
    assert np.abs(dy).max() == pytest.approx(1.5) and np.abs(dx).max() == pytest.approx(1.5)
    assert np.abs(np.diff(dy, axis=0)).max() < 1.0  # neighbouring pixels move together
    zy, zx = aug.elastic_field(np.random.default_rng(0), 28, sigma=3.0, max_px=0.0)
    assert not zy.any() and not zx.any()


def test_thickness_adds_or_removes_ink(digit):
    thicker = aug.change_thickness(digit, 1.0)
    thinner = aug.change_thickness(digit, -1.0)
    assert thicker.sum() > digit.sum() > thinner.sum()
    assert np.array_equal(aug.change_thickness(digit, 0.0), digit)
    half = aug.change_thickness(digit, 0.5)
    assert digit.sum() < half.sum() < thicker.sum()
    assert np.allclose(aug.change_thickness(digit, 5.0), thicker)  # clipped to [-1, 1]


def test_blur_smooths_and_keeps_total_ink(digit):
    blurred = aug.gaussian_blur(digit, 1.0)
    assert blurred.max() < digit.max()
    assert blurred.sum() == pytest.approx(digit.sum(), rel=0.02)
    assert aug.gaussian_blur(digit, 0.0) is digit
    assert aug.gaussian_kernel(1.5).sum() == pytest.approx(1.0)


def test_same_seed_same_result_and_different_seed_differs(digit):
    a = aug.augment(digit, np.random.default_rng(7))
    b = aug.augment(digit, np.random.default_rng(7))
    c = aug.augment(digit, np.random.default_rng(8))
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)


def test_batch_gives_each_image_its_own_parameters(digit):
    batch = np.stack([digit] * 6)
    out = aug.augment_batch(batch, np.random.default_rng(0), aug.LIGHT)
    assert out.shape == (6, 28, 28) and out.dtype == np.float32
    assert len({o.tobytes() for o in out}) == 6
    assert out.min() >= 0 and out.max() <= 1
