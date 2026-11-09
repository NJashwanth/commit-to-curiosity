"""Generate synthetic receipt images plus ground-truth JSON for the evals.

    python evals/generate.py [--out evals/receipts] [--count 10]

Output is deterministic per index (seeded), apart from font availability
on the machine. Each receipt_NN.png gets a receipt_NN.json next to it.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

FONT_CANDIDATES = [
    "DejaVuSansMono.ttf",
    "LiberationMono-Regular.ttf",
    "FreeMono.ttf",
    "DejaVuSans.ttf",
    "LiberationSerif-Regular.ttf",
    "DejaVuSerif.ttf",
    "LiberationSans-Regular.ttf",
]
FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/truetype/liberation",
    "/usr/share/fonts/truetype/freefont",
    "/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "C:/Windows/Fonts",
]

MERCHANTS = [
    "Corner Cafe", "Taco Libre", "Noodle House", "Blue Door Pizza", "Green Bowl",
    "Harbor Grill", "Sunrise Bakery", "The Daily Pour", "Spice Route", "Burger Barn",
]
MENU = [
    ("Margherita Pizza", 14.5), ("Caesar Salad", 9.75), ("Iced Latte", 4.95),
    ("Chicken Burrito", 11.25), ("Pad Thai", 13.0), ("Garlic Bread", 5.5),
    ("Fish Tacos", 12.75), ("Sparkling Water", 2.5), ("Tiramisu", 7.25),
    ("Cheeseburger", 10.95), ("Sweet Fries", 5.25), ("Miso Soup", 3.75),
    ("Veggie Bowl", 12.0), ("Craft Beer", 6.5), ("Espresso", 3.25),
    ("Croissant", 3.85), ("Ramen", 14.25), ("Guacamole", 6.95),
]
TAX_RATES = ["0", "0.0625", "0.075", "0.08875", "0.0825"]
TIP_RECEIPTS = {3: "0.18", 7: "0.20"}  # indices that print a tip line


def _cents(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def make_truth(index: int) -> dict:
    """Build a self-consistent ground-truth receipt for this index."""
    rng = random.Random(1000 + index)
    items = []
    for name, price in rng.sample(MENU, rng.randint(3, 8)):
        qty = rng.choice([1, 1, 1, 2, 3])
        unit = _cents(Decimal(str(price)))
        items.append(
            {"name": name, "qty": qty, "unit_price": float(unit), "total": float(unit * qty)}
        )
    subtotal = sum(Decimal(str(i["total"])) for i in items)
    tax = _cents(subtotal * Decimal(rng.choice(TAX_RATES)))
    tip = _cents(subtotal * Decimal(TIP_RECEIPTS[index])) if index in TIP_RECEIPTS else None
    total = subtotal + tax + (tip or Decimal(0))
    day = date(2026, 1, 1) + timedelta(days=rng.randint(0, 300))
    return {
        "merchant": MERCHANTS[index % len(MERCHANTS)],
        "date": day.isoformat(),
        "items": items,
        "subtotal": float(subtotal),
        "tax": float(tax),
        "tip": float(tip) if tip is not None else None,
        "total": float(total),
    }


def _pick_font_path(rng: random.Random) -> str | None:
    found = [
        str(Path(d) / f) for d in FONT_DIRS for f in FONT_CANDIDATES if (Path(d) / f).is_file()
    ]
    return rng.choice(found) if found else None


def _load_font(path: str | None, size: int) -> ImageFont.ImageFont:
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)  # Pillow >= 10.1


def render(truth: dict, index: int) -> Image.Image:
    """Draw the receipt on paper, then rotate slightly and add noise."""
    rng = random.Random(2000 + index)
    size = rng.choice([22, 24, 26, 28])
    font_path = _pick_font_path(rng)
    font = _load_font(font_path, size)
    small = _load_font(font_path, size - 6)
    line_h = size + 10
    width = rng.choice([520, 580, 640])
    pad = 36

    rows: list[tuple[str, str, bool]] = []  # (left, right, small)
    for it in truth["items"]:
        qty = it["qty"]
        left = f"{qty} x {it['name']}" if qty > 1 else it["name"]
        rows.append((left, f"{it['total']:.2f}", False))
        if qty > 1:
            rows.append((f"   @ {it['unit_price']:.2f} each", "", True))
    summary = [("SUBTOTAL", f"{truth['subtotal']:.2f}"), ("TAX", f"{truth['tax']:.2f}")]
    if truth["tip"] is not None:
        summary.append(("TIP", f"{truth['tip']:.2f}"))
    summary.append(("TOTAL", f"{truth['total']:.2f}"))

    height = pad * 2 + line_h * (len(rows) + len(summary) + 6)
    paper_tone = rng.randint(238, 252)
    paper = Image.new("RGB", (width, height), (paper_tone, paper_tone, paper_tone - 6))
    d = ImageDraw.Draw(paper)
    ink = (rng.randint(10, 50),) * 3

    y = pad
    d.text((width / 2, y), truth["merchant"].upper(), font=font, fill=ink, anchor="ma")
    y += line_h
    d.text((width / 2, y), truth["date"], font=small, fill=ink, anchor="ma")
    y += line_h + 6
    d.line([(pad, y), (width - pad, y)], fill=ink, width=1)
    y += 12
    for left, right, is_small in rows:
        f = small if is_small else font
        d.text((pad, y), left, font=f, fill=ink)
        if right:
            d.text((width - pad, y), right, font=f, fill=ink, anchor="ra")
        y += line_h - (6 if is_small else 0)
    y += 6
    d.line([(pad, y), (width - pad, y)], fill=ink, width=1)
    y += 12
    for left, right in summary:
        d.text((pad, y), left, font=font, fill=ink)
        d.text((width - pad, y), right, font=font, fill=ink, anchor="ra")
        y += line_h
    d.text((width / 2, y + 8), "THANK YOU", font=small, fill=ink, anchor="ma")

    angle = rng.uniform(-3.0, 3.0)
    bg = (rng.randint(60, 110),) * 3
    img = paper.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC, fillcolor=bg)
    if rng.random() < 0.5:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.4, 0.9)))
    noise = Image.effect_noise(img.size, rng.uniform(8, 18)).convert("RGB")
    return ImageChops.add(img, noise, scale=1.0, offset=-128)


def generate(out_dir: Path, count: int = 10) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(count):
        truth = make_truth(i)
        stem = out_dir / f"receipt_{i + 1:02d}"
        render(truth, i).save(stem.with_suffix(".png"))
        stem.with_suffix(".json").write_text(json.dumps(truth, indent=2) + "\n")
        paths.append(stem.with_suffix(".png"))
    return paths


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", type=Path, default=Path(__file__).parent / "receipts")
    p.add_argument("--count", type=int, default=10)
    args = p.parse_args(argv)
    paths = generate(args.out, args.count)
    print(f"Wrote {len(paths)} receipts + ground truth to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
