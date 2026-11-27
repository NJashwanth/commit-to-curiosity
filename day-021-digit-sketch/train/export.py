"""Export the trained network to compact JSON, and verify the file against PyTorch.

    python export.py --out ../web/public/model.json

The JSON holds the architecture (a list of layers) and the weights as flat row-major lists,
rounded to 7 significant digits (float32 carries about 7.2, so the rounding error is at most
float32's own resolution). After writing, the file is read back and a
pure NumPy forward pass over it is compared with PyTorch on real images. Finally the parity
fixtures for the TypeScript tests are regenerated from the same checkpoint (see fixtures.py),
so model.json and the fixtures can never drift apart.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

import dataset as ds
import evaluate as ev
import fixtures
import reference
from model import DigitCNN, count_params

SIG_DIGITS = 7
MAX_BYTES = 1_000_000
TOLERANCE = 1e-5


def _flat(t: torch.Tensor, sig: int | None) -> list[float]:
    values = t.detach().cpu().numpy().astype(np.float32).ravel().tolist()
    if sig is None:
        return values
    return [float(f"{v:.{sig}g}") for v in values]


def export_model(model: DigitCNN, meta: dict | None = None, sig: int | None = SIG_DIGITS) -> dict:
    """The model as a JSON-ready dict. Pass sig=None to keep full float32 precision (used by tests)."""
    c = model.config()
    layers = [
        {"type": "conv2d", "in": 1, "out": c["c1"], "kernel": 3,
         "weight": _flat(model.conv1.weight, sig), "bias": _flat(model.conv1.bias, sig)},
        {"type": "relu"},
        {"type": "maxpool", "size": 2},
        {"type": "conv2d", "in": c["c1"], "out": c["c2"], "kernel": 3,
         "weight": _flat(model.conv2.weight, sig), "bias": _flat(model.conv2.bias, sig)},
        {"type": "relu"},
        {"type": "maxpool", "size": 2},
        {"type": "flatten"},
        {"type": "dense", "in": c["c2"] * 25, "out": c["hidden"],
         "weight": _flat(model.fc1.weight, sig), "bias": _flat(model.fc1.bias, sig)},
        {"type": "relu"},
        {"type": "dense", "in": c["hidden"], "out": c["classes"],
         "weight": _flat(model.fc2.weight, sig), "bias": _flat(model.fc2.bias, sig)},
        {"type": "softmax"},
    ]
    return {
        "format": reference.FORMAT,
        "version": 1,
        "meta": {"params": count_params(model), **(meta or {})},
        "input": {"shape": [1, 28, 28], "mean": ds.MNIST_MEAN, "std": ds.MNIST_STD},
        "layers": layers,
    }


def write_json(spec: dict, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(spec, separators=(",", ":"))
    path.write_text(text)
    return len(text.encode())


def torch_probs(model: DigitCNN, x01: np.ndarray) -> np.ndarray:
    return ev.predict_probs(model, x01.astype(np.float32))


def compare(model: DigitCNN, spec_or_path, x01: np.ndarray) -> dict:
    """NumPy-over-JSON vs PyTorch on the same images: largest probability difference and prediction agreement."""
    ref = reference.predict(reference.load_model(spec_or_path), x01)
    pt = torch_probs(model, x01)
    return {
        "max_abs_diff": float(np.abs(ref - pt).max()),
        "predictions_match": bool((ref.argmax(1) == pt.argmax(1)).all()),
        "images": int(len(x01)),
    }


def load_checkpoint(path: Path) -> tuple[DigitCNN, dict]:
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    model = DigitCNN(**ckpt["config"])
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model, ckpt["metrics"]


def meta_from_metrics(metrics: dict) -> dict:
    return {
        "dataset": metrics["dataset"]["source"],
        "val_accuracy": round(metrics["val_accuracy"], 4),
        "test_accuracy": round(metrics["test_accuracy"], 4),
        "epochs": metrics["training"]["epochs"],
    }


def run(ckpt: Path, out: Path, data_dir: str, verify_images: int, log=print, fixtures_dir: Path | None = None) -> dict:
    model, metrics = load_checkpoint(ckpt)
    spec = export_model(model, meta_from_metrics(metrics))
    size = write_json(spec, out)
    log(f"wrote {out} ({size / 1024:.0f} KiB, {spec['meta']['params']:,} params, trained on {spec['meta']['dataset']})")
    if size > MAX_BYTES:
        log(f"warning: {size:,} bytes is over the {MAX_BYTES:,} byte budget; do not commit it")

    # Verify the file that was actually written, on real images the network has not trained on.
    source = "mnist" if metrics["dataset"]["source"] == ds.SOURCE_MNIST else "synthetic"
    data = ds.load_dataset(source, data_dir=data_dir, seed=metrics["training"]["seed"])
    x = data.x_test[:verify_images]
    result = compare(model, out, x)
    log(f"verified on {result['images']} test images: max |numpy - pytorch| = {result['max_abs_diff']:.2e}, "
        f"predictions identical: {result['predictions_match']}")
    if result["max_abs_diff"] > TOLERANCE or not result["predictions_match"]:
        raise SystemExit(f"export verification failed (tolerance {TOLERANCE})")
    if fixtures_dir is not None:
        written = fixtures.write_fixtures(fixtures_dir, model, data.x_test, data.y_test, out)
        log(f"wrote parity fixtures to {fixtures_dir} ({written['ops']} op cases, {written['images']} images)")
    return {"bytes": size, **result}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ckpt", type=Path, default=Path("runs/latest/model.pt"))
    p.add_argument("--out", type=Path, default=Path("../web/public/model.json"))
    p.add_argument("--data-dir", default="data")
    p.add_argument("--verify-images", type=int, default=500)
    p.add_argument("--fixtures-dir", type=Path, default=fixtures.DEFAULT_DIR,
                   help="where to write the TypeScript parity fixtures (default: web/tests/fixtures)")
    p.add_argument("--no-fixtures", action="store_true", help="only write model.json")
    args = p.parse_args(argv)
    run(args.ckpt, args.out, args.data_dir, args.verify_images, fixtures_dir=None if args.no_fixtures else args.fixtures_dir)


if __name__ == "__main__":
    main()
