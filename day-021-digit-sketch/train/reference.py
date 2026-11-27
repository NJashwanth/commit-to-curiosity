"""Pure NumPy forward pass over the exported model.json.

This is the reference the export is verified against: it reads the JSON (not the PyTorch
checkpoint), so it proves the file contains the whole network. The TypeScript engine in
web/src/nn follows the same layer semantics.

Layouts (same as PyTorch):  conv weight (out, in, k, k),  dense weight (out, in),
activations (N, C, H, W) for conv layers and (N, features) after flatten.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

FORMAT = "digit-sketch-cnn"


def conv2d(x: np.ndarray, weight: np.ndarray, bias: np.ndarray) -> np.ndarray:
    """Valid (no padding) stride-1 convolution. x (N, C, H, W) -> (N, O, H-k+1, W-k+1)."""
    k = weight.shape[-1]
    windows = sliding_window_view(x, (k, k), axis=(2, 3))  # (N, C, H', W', k, k)
    out = np.einsum("nchwij,ocij->nohw", windows, weight, optimize=True)
    return out + bias[None, :, None, None]


def relu(x: np.ndarray) -> np.ndarray:
    return np.maximum(x, 0.0)


def maxpool2d(x: np.ndarray, size: int = 2) -> np.ndarray:
    """Non-overlapping max pooling; a trailing odd row or column is dropped (floor), like PyTorch."""
    n, c, h, w = x.shape
    ho, wo = h // size, w // size
    x = x[:, :, : ho * size, : wo * size]
    return x.reshape(n, c, ho, size, wo, size).max(axis=(3, 5))


def flatten(x: np.ndarray) -> np.ndarray:
    return x.reshape(x.shape[0], -1)


def dense(x: np.ndarray, weight: np.ndarray, bias: np.ndarray) -> np.ndarray:
    return x @ weight.T + bias


def softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


def load_model(path_or_dict) -> dict:
    """Load model.json (or an already parsed dict) and turn the weight lists into float64 arrays."""
    spec = path_or_dict if isinstance(path_or_dict, dict) else json.loads(Path(path_or_dict).read_text())
    if spec.get("format") != FORMAT:
        raise ValueError(f"not a {FORMAT} file (format={spec.get('format')!r})")
    layers = []
    for layer in spec["layers"]:
        layer = dict(layer)
        if layer["type"] == "conv2d":
            k = layer["kernel"]
            layer["weight"] = np.asarray(layer["weight"], dtype=np.float64).reshape(layer["out"], layer["in"], k, k)
            layer["bias"] = np.asarray(layer["bias"], dtype=np.float64)
        elif layer["type"] == "dense":
            layer["weight"] = np.asarray(layer["weight"], dtype=np.float64).reshape(layer["out"], layer["in"])
            layer["bias"] = np.asarray(layer["bias"], dtype=np.float64)
        layers.append(layer)
    return {**spec, "layers": layers}


def normalize_input(model: dict, x01: np.ndarray) -> np.ndarray:
    """Images in [0, 1], shape (N, 28, 28) or (N, 1, 28, 28), to the normalized (N, 1, 28, 28) the network expects."""
    x = np.asarray(x01, dtype=np.float64)
    if x.ndim == 3:
        x = x[:, None]
    return (x - model["input"]["mean"]) / model["input"]["std"]


def forward(model: dict, x: np.ndarray, trace: bool = False):
    """Run normalized input (N, 1, 28, 28) through the layers. Returns probabilities (N, 10),
    or (probabilities, [output of every layer]) when trace is true."""
    outputs = []
    for layer in model["layers"]:
        kind = layer["type"]
        if kind == "conv2d":
            x = conv2d(x, layer["weight"], layer["bias"])
        elif kind == "relu":
            x = relu(x)
        elif kind == "maxpool":
            x = maxpool2d(x, layer["size"])
        elif kind == "flatten":
            x = flatten(x)
        elif kind == "dense":
            x = dense(x, layer["weight"], layer["bias"])
        elif kind == "softmax":
            x = softmax(x)
        else:
            raise ValueError(f"unknown layer type {kind!r}")
        outputs.append(x)
    return (x, outputs) if trace else x


def predict(model: dict, x01: np.ndarray) -> np.ndarray:
    """Probabilities for images in [0, 1]."""
    return forward(model, normalize_input(model, x01))
