"""Load, resize, and convert receipt images for the vision API."""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_DIMENSION = 1568  # longest side; larger images gain nothing for the model
MAX_BYTES = 5 * 1024 * 1024  # API limit per image
JPEG_EXTS = {".jpg", ".jpeg"}
HEIC_EXTS = {".heic", ".heif"}
SUPPORTED_EXTS = JPEG_EXTS | HEIC_EXTS | {".png"}


class ImageError(Exception):
    """The image could not be read or is not a supported format."""


@dataclass
class PreparedImage:
    media_type: str
    data: bytes

    @property
    def b64(self) -> str:
        return base64.standard_b64encode(self.data).decode("ascii")


def _register_heif() -> None:
    try:
        from pillow_heif import register_heif_opener
    except ImportError as exc:  # pragma: no cover - dependency is in requirements
        raise ImageError("HEIC support needs pillow-heif (pip install pillow-heif)") from exc
    register_heif_opener()


def _encode(img: Image.Image, fmt: str, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    if fmt == "JPEG":
        img.convert("RGB").save(buf, "JPEG", quality=quality)
    else:
        img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def prepare_image(path: str | Path, max_dim: int = MAX_DIMENSION) -> PreparedImage:
    """Read an image, fix orientation, shrink it if large, return API-ready bytes.

    HEIC/HEIF is converted to JPEG. Unmodified JPEG/PNG files are passed
    through untouched so we never degrade a small, already-fine image.
    """
    p = Path(path)
    ext = p.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise ImageError(
            f"Unsupported image format '{ext or p.name}'. Use jpg, png, or heic."
        )
    if not p.is_file():
        raise ImageError(f"File not found: {p}")
    if ext in HEIC_EXTS:
        _register_heif()

    raw = p.read_bytes()
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageError(f"Could not read {p.name} as an image: {exc}") from exc

    oriented = ImageOps.exif_transpose(img)
    changed = oriented is not img and oriented.getexif() != img.getexif()
    img = oriented

    if max(img.size) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        changed = True

    is_png = ext == ".png"
    if ext in HEIC_EXTS:
        changed = True

    if not changed and len(raw) <= MAX_BYTES:
        return PreparedImage("image/png" if is_png else "image/jpeg", raw)

    fmt = "PNG" if is_png else "JPEG"
    data = _encode(img, fmt)
    if len(data) > MAX_BYTES:  # e.g. a huge noisy PNG: fall back to JPEG
        fmt, data = "JPEG", _encode(img, "JPEG", quality=80)
    return PreparedImage("image/png" if fmt == "PNG" else "image/jpeg", data)
