"""Parity fixtures for the TypeScript engine, generated with PyTorch.

    python fixtures.py            (export.py also runs this after writing model.json)

Writes three files into web/tests/fixtures/:
  ops.json         small seeded inputs for every operation, with the output PyTorch computes
  preprocess.json  drawings (as 0..255 canvases) with the 28x28 image train/preprocess.py makes from each
  forward.json     20 real test images (two per digit) with PyTorch's probabilities, plus a fingerprint of
                the model.json they were made for, so stale fixtures are caught by a test
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

import dataset as ds
import evaluate as ev
import preprocess as pp
import synthetic

WEB = Path(__file__).resolve().parent.parent / "web"
DEFAULT_DIR = WEB / "tests" / "fixtures"


def _t(arr) -> dict:
    a = np.asarray(arr, dtype=np.float32)
    return {"shape": list(a.shape), "data": [float(f"{v:.9g}") for v in a.ravel()]}


def make_op_fixtures(seed: int = 0) -> dict:
    """Expected outputs of PyTorch's own conv2d, relu, max_pool2d, flatten, linear and softmax."""
    g = torch.Generator().manual_seed(seed)

    def rand(*shape, scale=1.0):
        return torch.randn(*shape, generator=g) * scale

    fx: dict[str, list] = {"conv2d": [], "relu": [], "maxpool": [], "flatten": [], "dense": [], "softmax": []}

    for in_c, out_c, k, h, w in [(1, 3, 3, 8, 8), (2, 4, 3, 7, 9), (3, 2, 3, 5, 5), (2, 2, 1, 4, 4)]:
        x, wt, b = rand(in_c, h, w), rand(out_c, in_c, k, k, scale=0.5), rand(out_c)
        y = F.conv2d(x[None], wt, b)[0]
        fx["conv2d"].append({"input": _t(x), "weight": _t(wt), "bias": _t(b), "out": out_c, "kernel": k, "expected": _t(y)})

    for shape in [(2, 3, 3), (1, 5, 4), (12,)]:
        x = rand(*shape)
        x.view(-1)[0] = 0.0  # an exact zero must stay zero
        fx["relu"].append({"input": _t(x), "expected": _t(torch.relu(x))})

    for c, h, w, size in [(2, 6, 6, 2), (3, 7, 5, 2), (1, 9, 9, 3), (2, 4, 4, 4)]:
        x = rand(c, h, w)
        y = F.max_pool2d(x[None], size)[0]
        fx["maxpool"].append({"input": _t(x), "size": size, "expected": _t(y)})

    for shape in [(2, 3, 4), (3, 1, 1), (1, 5, 5)]:
        x = rand(*shape)
        fx["flatten"].append({"input": _t(x), "expected": _t(x.flatten())})

    for n_in, n_out in [(6, 3), (25, 10), (1, 1)]:
        x, wt, b = rand(n_in), rand(n_out, n_in, scale=0.5), rand(n_out)
        fx["dense"].append({"input": _t(x), "weight": _t(wt), "bias": _t(b), "out": n_out, "expected": _t(F.linear(x, wt, b))})

    for scale in (1.0, 30.0, 200.0):  # huge logits would overflow a naive exp
        x = rand(10, scale=scale)
        fx["softmax"].append({"input": _t(x), "expected": _t(torch.softmax(x, 0))})
    fx["softmax"].append({"input": _t(torch.zeros(10)), "expected": _t(torch.full((10,), 0.1))})
    return fx


def _canvas(img01: np.ndarray) -> np.ndarray:
    return np.clip(np.round(img01 * 255.0), 0, 255).astype(np.uint8)


def make_preprocess_fixtures() -> dict:
    """Drawings of different sizes and shapes, quantised to bytes like a canvas, with the Python recipe's output."""
    from PIL import Image

    def digit(d: int, size: int, off: tuple[int, int] = (0, 0), canvas: tuple[int, int] | None = None) -> np.ndarray:
        img = Image.fromarray(_canvas(synthetic.render_digit(None, d))).resize((size, size), Image.BILINEAR)
        arr = np.asarray(img)
        if canvas is None:
            return arr
        out = np.zeros((canvas[1], canvas[0]), dtype=np.uint8)
        out[off[1] : off[1] + size, off[0] : off[0] + size] = arr
        return out

    l_shape = np.zeros((50, 80), dtype=np.uint8)
    l_shape[5:45, 10:22] = 255
    l_shape[33:45, 10:70] = 255
    faint_bar = np.zeros((48, 48), dtype=np.uint8)
    faint_bar[4:44, 22:25] = 100
    dot = np.zeros((40, 40), dtype=np.uint8)
    dot[17, 25] = 255
    diagonal = np.zeros((60, 60), dtype=np.uint8)
    for i in range(10, 50):
        diagonal[i, i - 2 : i + 2] = 255
    canvases = [
        ("a 3 filling a 64x64 canvas", digit(3, 64)),
        ("a 7 filling a 64x64 canvas", digit(7, 64)),
        ("a small 5 off to one side of a wide canvas", digit(5, 30, off=(55, 8), canvas=(100, 48))),
        ("an L shape: mass far from the bounding box center", l_shape),
        ("a faint thin vertical bar", faint_bar),
        ("a single pixel", dot),
        ("a diagonal stroke", diagonal),
        ("an empty canvas", np.zeros((32, 32), dtype=np.uint8)),
    ]
    cases = []
    for name, arr in canvases:
        expected = pp.mnist_style(arr.astype(np.float64) / 255.0)
        cases.append({
            "name": name, "width": int(arr.shape[1]), "height": int(arr.shape[0]),
            "pixels": arr.ravel().tolist(), "empty": bool(expected.max() == 0),
            "expected": [float(f"{v:.9g}") for v in expected.ravel()],
        })
    return {"cases": cases}


def fingerprint(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


def pick_per_digit(y: np.ndarray, per_digit: int = 2) -> list[int]:
    """The first `per_digit` indices of every digit 0..9, in digit order."""
    picks = []
    for d in range(10):
        picks.extend(np.nonzero(y == d)[0][:per_digit].tolist())
    return picks


def make_forward_fixtures(model, x01: np.ndarray, y: np.ndarray, model_json: Path, per_digit: int = 2) -> dict:
    """Images as 0..255 ints (what a canvas holds) and the probabilities PyTorch gives for exactly those pixels."""
    idx = pick_per_digit(y, per_digit)
    pixels = np.clip(np.round(x01[idx] * 255.0), 0, 255).astype(np.uint8)
    probs = ev.predict_probs(model, pixels.astype(np.float32) / 255.0)
    return {
        "model_fingerprint": fingerprint(model_json),
        "mean": ds.MNIST_MEAN,
        "std": ds.MNIST_STD,
        "labels": [int(y[i]) for i in idx],
        "predictions": [int(p) for p in probs.argmax(1)],
        "images": pixels.reshape(len(idx), -1).tolist(),
        "probs": [[float(f"{v:.9g}") for v in row] for row in probs],
    }


def write_fixtures(out_dir: Path, model, x01: np.ndarray, y: np.ndarray, model_json: Path) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ops, fwd = make_op_fixtures(), make_forward_fixtures(model, x01, y, model_json)
    (out_dir / "ops.json").write_text(json.dumps(ops, separators=(",", ":")))
    (out_dir / "forward.json").write_text(json.dumps(fwd, separators=(",", ":")))
    (out_dir / "preprocess.json").write_text(json.dumps(make_preprocess_fixtures(), separators=(",", ":")))
    return {"ops": len(sum(ops.values(), [])), "images": len(fwd["labels"])}


def main(argv: list[str] | None = None) -> None:
    from export import load_checkpoint  # local import: export imports this module's siblings

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ckpt", type=Path, default=Path("runs/latest/model.pt"))
    p.add_argument("--model-json", type=Path, default=WEB / "public" / "model.json")
    p.add_argument("--out", type=Path, default=DEFAULT_DIR)
    p.add_argument("--data-dir", default="data")
    args = p.parse_args(argv)
    model, metrics = load_checkpoint(args.ckpt)
    source = "mnist" if metrics["dataset"]["source"] == ds.SOURCE_MNIST else "synthetic"
    data = ds.load_dataset(source, data_dir=args.data_dir, seed=metrics["training"]["seed"])
    print(write_fixtures(args.out, model, data.x_test, data.y_test, args.model_json), "->", args.out)


if __name__ == "__main__":
    main()
