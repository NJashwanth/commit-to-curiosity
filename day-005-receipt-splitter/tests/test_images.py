import io

import pytest
from PIL import Image

import images
from images import ImageError, prepare_image


def _save(tmp_path, name, size=(200, 300), fmt=None, mode="RGB", **kw):
    p = tmp_path / name
    Image.new(mode, size, "white").save(p, format=fmt, **kw)
    return p


def _open(data):
    return Image.open(io.BytesIO(data))


def test_small_jpeg_passes_through_unchanged(tmp_path):
    p = _save(tmp_path, "r.jpg", fmt="JPEG")
    out = prepare_image(p)
    assert out.media_type == "image/jpeg"
    assert out.data == p.read_bytes()


def test_small_png_passes_through_unchanged(tmp_path):
    p = _save(tmp_path, "r.png", fmt="PNG")
    out = prepare_image(p)
    assert out.media_type == "image/png"
    assert out.data == p.read_bytes()


def test_uppercase_extension_ok(tmp_path):
    p = _save(tmp_path, "R.JPEG", fmt="JPEG")
    assert prepare_image(p).media_type == "image/jpeg"


def test_large_image_is_resized_keeping_aspect(tmp_path):
    p = _save(tmp_path, "big.jpg", size=(4000, 2000), fmt="JPEG")
    out = prepare_image(p, max_dim=1000)
    img = _open(out.data)
    assert img.size == (1000, 500)
    assert out.media_type == "image/jpeg"


def test_large_png_stays_png_when_resized(tmp_path):
    p = _save(tmp_path, "big.png", size=(3000, 1500), fmt="PNG")
    out = prepare_image(p, max_dim=1500)
    assert out.media_type == "image/png"
    assert _open(out.data).size == (1500, 750)


def test_default_max_dimension(tmp_path):
    p = _save(tmp_path, "big.jpg", size=(3136, 800), fmt="JPEG")
    assert max(_open(prepare_image(p).data).size) == images.MAX_DIMENSION


def test_heic_is_converted_to_jpeg(tmp_path):
    pillow_heif = pytest.importorskip("pillow_heif")
    p = tmp_path / "r.heic"
    heif = pillow_heif.from_pillow(Image.new("RGB", (120, 160), "white"))
    heif.save(p)
    out = prepare_image(p)
    assert out.media_type == "image/jpeg"
    assert _open(out.data).format == "JPEG"
    assert _open(out.data).size == (120, 160)


def test_exif_rotation_is_applied(tmp_path):
    img = Image.new("RGB", (200, 100), "white")
    exif = img.getexif()
    exif[0x0112] = 6  # rotate 90 CW on display
    p = tmp_path / "rot.jpg"
    img.save(p, "JPEG", exif=exif)
    out = prepare_image(p)
    assert _open(out.data).size == (100, 200)


def test_oversized_png_falls_back_to_jpeg(tmp_path, monkeypatch):
    p = _save(tmp_path, "r.png", fmt="PNG")
    monkeypatch.setattr(images, "MAX_BYTES", 10)
    out = prepare_image(p)
    assert out.media_type == "image/jpeg"


def test_unsupported_format_error(tmp_path):
    p = tmp_path / "r.gif"
    p.write_bytes(b"GIF89a")
    with pytest.raises(ImageError, match="Unsupported image format '.gif'"):
        prepare_image(p)


def test_no_extension_error(tmp_path):
    p = tmp_path / "receipt"
    p.write_bytes(b"x")
    with pytest.raises(ImageError, match="Unsupported"):
        prepare_image(p)


def test_missing_file_error(tmp_path):
    with pytest.raises(ImageError, match="not found"):
        prepare_image(tmp_path / "nope.jpg")


def test_corrupt_file_error(tmp_path):
    p = tmp_path / "bad.jpg"
    p.write_bytes(b"this is not a jpeg")
    with pytest.raises(ImageError, match="Could not read"):
        prepare_image(p)


def test_b64_roundtrip(tmp_path):
    import base64

    p = _save(tmp_path, "r.jpg", fmt="JPEG")
    out = prepare_image(p)
    assert base64.b64decode(out.b64) == out.data
