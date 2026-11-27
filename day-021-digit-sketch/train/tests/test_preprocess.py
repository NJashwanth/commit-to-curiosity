import numpy as np
import pytest

import preprocess as pp


def blob(h=60, w=60, y0=10, y1=40, x0=15, x1=30, value=1.0):
    img = np.zeros((h, w))
    img[y0:y1, x0:x1] = value
    return img


def test_area_weights_rows_sum_to_one_and_resize_keeps_the_mean():
    for src, dst in [(100, 20), (7, 20), (20, 20), (33, 5)]:
        w = pp.area_weights(src, dst)
        assert w.shape == (dst, src)
        assert np.allclose(w.sum(axis=1), 1.0)
    img = np.random.default_rng(0).random((60, 40))
    assert pp.resize_area(img, 20, 10).mean() == pytest.approx(img.mean())
    assert np.allclose(pp.resize_area(img, 60, 40), img)


def test_center_of_mass_uses_continuous_coordinates():
    img = np.zeros((28, 28))
    img[13:15, 13:15] = 1.0  # the 2x2 block around the exact middle
    assert pp.center_of_mass(img) == pytest.approx((14.0, 14.0))
    assert pp.center_of_mass(np.zeros((5, 5))) is None


def test_empty_drawing_gives_an_empty_28x28():
    out = pp.mnist_style(np.zeros((100, 100)))
    assert out.shape == (28, 28) and out.dtype == np.float32
    assert out.max() == 0.0
    assert pp.mnist_style(np.full((50, 50), 0.05)).max() == 0.0  # below the ink threshold


def test_output_is_28x28_and_the_digit_fits_a_20_pixel_box():
    out = pp.mnist_style(blob())
    assert out.shape == (28, 28)
    ys, xs = np.nonzero(out > 0)
    assert max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1) == 20
    assert out.max() == pytest.approx(1.0)  # peak is normalized


def test_tall_shapes_keep_their_aspect_ratio():
    out = pp.mnist_style(blob(y0=5, y1=55, x0=20, x1=30))  # 50 tall, 10 wide
    ys, xs = np.nonzero(out > 0)
    assert ys.max() - ys.min() + 1 == 20
    assert xs.max() - xs.min() + 1 == 4


def test_center_of_mass_is_moved_to_the_middle():
    # An L shape: its bounding box center is far from its center of mass.
    img = np.zeros((80, 80))
    img[10:70, 10:20] = 1.0
    img[60:70, 10:60] = 1.0
    out = pp.mnist_style(img)
    cy, cx = pp.center_of_mass(out)
    assert abs(cy - 14.0) <= 0.5 and abs(cx - 14.0) <= 0.5
    # the bounding box is not what is centered
    ys, xs = np.nonzero(out > 0)
    assert abs((xs.min() + xs.max() + 1) / 2 - 14.0) > 1.0


def test_result_does_not_depend_on_where_or_how_large_the_drawing_was():
    a = pp.mnist_style(blob(60, 60, 10, 40, 15, 30))
    b = pp.mnist_style(blob(200, 300, 100, 160, 120, 150))  # same 30x15 aspect (2:1), different place and size
    assert np.allclose(a, b, atol=1e-6)


def test_extreme_mass_offset_never_pushes_the_digit_out_of_the_field():
    img = np.zeros((100, 100))
    img[0:100, 0:4] = 1.0          # a heavy bar on the left ...
    img[48:52, 0:100] = 0.2        # ... and a long faint arm to the right
    out = pp.mnist_style(img)
    assert out.shape == (28, 28)
    assert out.sum() > 0
    ys, xs = np.nonzero(out > 0)
    assert xs.min() >= 0 and xs.max() <= 27 and ys.min() >= 0 and ys.max() <= 27


def test_round_half_up_matches_javascript_math_round():
    assert [pp._round_half_up(v) for v in (0.5, 1.5, 2.5, -0.5, -1.5, 2.4)] == [1, 2, 3, 0, -1, 2]
