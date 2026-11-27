import numpy as np
import pytest

import synthetic


def test_find_fonts_walks_directories_and_ignores_other_files(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "One.TTF").write_bytes(b"")
    (tmp_path / "Two.otf").write_bytes(b"")
    (tmp_path / "notes.txt").write_text("x")
    found = synthetic.find_fonts([str(tmp_path), str(tmp_path / "missing")])
    assert sorted(p.rsplit("/", 1)[1] for p in found) == ["One.TTF", "Two.otf"]
    assert found == sorted(found)


def test_render_digit_draws_ink_on_a_black_canvas():
    img = synthetic.render_digit(None, 8)
    assert img.shape == (synthetic.CANVAS, synthetic.CANVAS)
    assert img.min() == 0.0 and img.max() == 1.0


def test_a_broken_font_file_is_skipped_and_the_default_font_is_the_last_resort(tmp_path):
    bad = tmp_path / "broken.ttf"
    bad.write_bytes(b"not a font")
    assert synthetic.base_digits(str(bad)) is None
    fonts, bases = synthetic.usable_fonts([str(bad)])
    assert fonts == [None] and bases[0].shape == (10, 28, 28)


def test_base_digits_are_ten_distinct_mnist_style_images(bases):
    assert len(bases) >= 1
    b = bases[0]
    assert b.shape == (10, 28, 28)
    assert len({x.tobytes() for x in b}) == 10


def test_generate_is_balanced_deterministic_and_valid(bases):
    x, y = synthetic.generate(200, seed=5, bases=bases)
    x2, y2 = synthetic.generate(200, seed=5, bases=bases)
    x3, _ = synthetic.generate(200, seed=6, bases=bases)
    assert x.shape == (200, 28, 28) and x.dtype == np.float32 and y.dtype == np.int64
    assert np.array_equal(x, x2) and np.array_equal(y, y2)
    assert not np.array_equal(x, x3)
    assert np.bincount(y, minlength=10).tolist() == [20] * 10
    assert x.min() >= 0.0 and x.max() <= 1.0


def test_split_fonts_holds_out_every_fifth_font_when_there_are_enough():
    many = [np.full((10, 28, 28), i, dtype=np.float32) for i in range(12)]
    train, test = synthetic.split_fonts(many)
    assert [t[0, 0, 0] for t in test] == [0, 5, 10]
    assert len(train) == 9 and not set(t[0, 0, 0] for t in train) & {0, 5, 10}
    few = many[:3]
    assert synthetic.split_fonts(few) == (few, few)
