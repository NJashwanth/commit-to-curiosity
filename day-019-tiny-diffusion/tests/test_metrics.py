import pytest
import torch

from datasets import make_dataset
from metrics import chamfer_distance, evaluate, gaussian_baseline, mmd


@pytest.fixture
def pts():
    return make_dataset("moons", 300, seed=0)


def test_zero_for_identical_sets(pts):
    assert chamfer_distance(pts, pts) == 0.0
    assert mmd(pts, pts) == pytest.approx(0.0, abs=1e-6)


def test_larger_for_shifted_sets(pts):
    near = chamfer_distance(pts, pts + 0.1), mmd(pts, pts + 0.1)
    far = chamfer_distance(pts, pts + 1.0), mmd(pts, pts + 1.0)
    assert 0 < near[0] < far[0] and 0 < near[1] < far[1]


def test_chamfer_is_symmetric_and_known_value():
    a = torch.zeros(1, 2)
    b = torch.tensor([[3.0, 4.0]])
    assert chamfer_distance(a, b) == pytest.approx(10.0)  # 5 + 5
    assert chamfer_distance(b, a) == pytest.approx(10.0)


def test_mmd_symmetric(pts):
    other = make_dataset("spiral", 300, seed=0)
    assert mmd(pts, other) == pytest.approx(mmd(other, pts), abs=1e-6)


def test_gaussian_baseline_matches_moments(pts):
    g = gaussian_baseline(pts, 20000, seed=1)
    assert g.shape == (20000, 2)
    assert torch.allclose(g.mean(0), pts.mean(0), atol=0.05)
    assert torch.allclose(g.std(0), pts.std(0), atol=0.05)
    assert torch.equal(g, gaussian_baseline(pts, 20000, seed=1))


def test_evaluate_ranks_real_below_gaussian():
    real = make_dataset("spiral", 400, seed=50)
    res = evaluate("spiral", real)
    assert set(res) == {"chamfer", "mmd", "real_chamfer", "real_mmd",
                        "gaussian_chamfer", "gaussian_mmd"}
    assert res["chamfer"] < res["gaussian_chamfer"]
    assert res["mmd"] < res["gaussian_mmd"]
    assert res["real_chamfer"] < res["gaussian_chamfer"]
