import numpy as np
import pytest
import torch
import torch.nn.functional as F

import reference as ref
from export import export_model
from model import DigitCNN


def rnd(*shape, seed=0):
    return np.random.default_rng(seed).standard_normal(shape)


def test_conv2d_matches_torch():
    x, w, b = rnd(3, 4, 12, 12), rnd(5, 4, 3, 3, seed=1), rnd(5, seed=2)
    got = ref.conv2d(x, w, b)
    want = F.conv2d(torch.from_numpy(x), torch.from_numpy(w), torch.from_numpy(b)).numpy()
    assert got.shape == (3, 5, 10, 10)
    assert np.allclose(got, want, atol=1e-10)


def test_conv2d_on_a_hand_checkable_case():
    x = np.arange(16, dtype=float).reshape(1, 1, 4, 4)
    w = np.ones((1, 1, 3, 3))
    out = ref.conv2d(x, w, np.array([1.0]))
    assert out.shape == (1, 1, 2, 2)
    assert out[0, 0, 0, 0] == (0 + 1 + 2 + 4 + 5 + 6 + 8 + 9 + 10) + 1


def test_relu_maxpool_flatten_dense_softmax_match_torch():
    x = rnd(2, 3, 7, 7)
    assert np.array_equal(ref.relu(x), np.maximum(x, 0))
    assert np.allclose(ref.maxpool2d(x, 2), F.max_pool2d(torch.from_numpy(x), 2).numpy())
    assert ref.maxpool2d(x, 2).shape == (2, 3, 3, 3)          # odd edge dropped
    assert ref.flatten(x).shape == (2, 147)
    v, w, b = rnd(4, 9), rnd(6, 9, seed=3), rnd(6, seed=4)
    assert np.allclose(ref.dense(v, w, b), F.linear(*(torch.from_numpy(t) for t in (v, w, b))).numpy())
    p = ref.softmax(rnd(5, 10) * 50)  # large logits must not overflow
    assert np.allclose(p.sum(axis=1), 1.0) and np.isfinite(p).all()
    assert np.allclose(p, F.softmax(torch.from_numpy(rnd(5, 10) * 50), dim=1).numpy())


@pytest.fixture(scope="module")
def trained_ish():
    """A randomly initialised model with its weights scaled up so logits are not tiny."""
    torch.manual_seed(0)
    model = DigitCNN().eval()
    with torch.no_grad():
        for p in model.parameters():
            p.mul_(2.0)
    return model


def test_numpy_forward_matches_pytorch_within_1e_5(trained_ish):
    x = np.random.default_rng(0).random((40, 28, 28)).astype(np.float32)
    spec = ref.load_model(export_model(trained_ish, sig=None))  # full float32 precision: no export rounding
    got = ref.predict(spec, x)
    want = torch.softmax(trained_ish(torch.from_numpy((x - 0.1307) / 0.3081).unsqueeze(1)), 1).detach().numpy()
    assert got.shape == (40, 10)
    assert np.abs(got - want).max() < 1e-5
    assert (got.argmax(1) == want.argmax(1)).all()


def test_trace_returns_every_layers_output(trained_ish):
    spec = ref.load_model(export_model(trained_ish, sig=None))
    x = ref.normalize_input(spec, np.zeros((1, 28, 28)))
    probs, trace = ref.forward(spec, x, trace=True)
    shapes = [t.shape for t in trace]
    assert shapes == [(1, 16, 26, 26), (1, 16, 26, 26), (1, 16, 13, 13), (1, 32, 11, 11), (1, 32, 11, 11),
                      (1, 32, 5, 5), (1, 800), (1, 64), (1, 64), (1, 10), (1, 10)]
    assert np.array_equal(trace[-1], probs)


def test_bad_files_and_layers_are_rejected(trained_ish):
    with pytest.raises(ValueError, match="not a digit-sketch-cnn"):
        ref.load_model({"format": "something-else"})
    spec = ref.load_model(export_model(trained_ish, sig=None))
    spec["layers"] = [{"type": "tanh"}]
    with pytest.raises(ValueError, match="unknown layer type"):
        ref.forward(spec, np.zeros((1, 1, 28, 28)))


def test_normalize_input_accepts_both_layouts(trained_ish):
    spec = ref.load_model(export_model(trained_ish, sig=None))
    img = np.random.default_rng(0).random((2, 28, 28))
    assert np.array_equal(ref.normalize_input(spec, img), ref.normalize_input(spec, img[:, None]))
