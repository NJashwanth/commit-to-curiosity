import pytest
import torch

from model import Denoiser
from sample import ddim_sample, ddim_timesteps, ddpm_sample
from schedule import make_schedule
from train import Config, train


class Counting(Denoiser):
    calls = 0

    def forward(self, x, t):
        type(self).calls += 1
        return super().forward(x, t)


@pytest.fixture(scope="module")
def schedule():
    return make_schedule("cosine", 20)


@pytest.fixture(scope="module")
def model():
    torch.manual_seed(0)
    return Denoiser(hidden=16, n_layers=2, time_dim=8).eval()


def test_ddpm_shape_and_determinism(model, schedule):
    a = ddpm_sample(model, schedule, 17, seed=4)
    b = ddpm_sample(model, schedule, 17, seed=4)
    c = ddpm_sample(model, schedule, 17, seed=5)
    assert a.shape == (17, 2) and torch.equal(a, b) and not torch.equal(a, c)


def test_ddpm_trajectory_length(model, schedule):
    x, traj = ddpm_sample(model, schedule, 5, seed=0, return_trajectory=True)
    assert len(traj) == schedule.T + 1 and torch.equal(traj[-1], x)
    assert torch.equal(x, ddpm_sample(model, schedule, 5, seed=0))


@pytest.mark.parametrize("eta", [0.0, 1.0])
def test_ddim_shape_and_determinism(model, schedule, eta):
    a = ddim_sample(model, schedule, 11, steps=5, seed=2, eta=eta)
    b = ddim_sample(model, schedule, 11, steps=5, seed=2, eta=eta)
    assert a.shape == (11, 2) and torch.equal(a, b)


@pytest.mark.parametrize("steps", [1, 5, 10, 20])
def test_ddim_uses_requested_number_of_steps(schedule, steps):
    torch.manual_seed(0)
    counting = Counting(hidden=16, n_layers=2, time_dim=8).eval()
    Counting.calls = 0
    _, traj = ddim_sample(counting, schedule, 4, steps=steps, return_trajectory=True)
    assert Counting.calls == steps and len(traj) == steps + 1


def test_ddim_timesteps():
    ts = ddim_timesteps(100, 50)
    assert len(ts) == 50 and ts[0] == 99 and ts[-1] == 0
    assert ts == sorted(set(ts), reverse=True)
    assert ddim_timesteps(10, 10) == list(range(9, -1, -1))
    for bad in (0, 11):
        with pytest.raises(ValueError):
            ddim_timesteps(10, bad)


def test_no_clip_option(model, schedule):
    assert ddpm_sample(model, schedule, 3, clip=None).shape == (3, 2)
    assert ddim_sample(model, schedule, 3, steps=4, clip=None).shape == (3, 2)


def test_clipping_bounds_predicted_x0(schedule):
    class Huge(torch.nn.Module):
        def forward(self, x, t):
            return torch.full_like(x, 1e4)

    out = ddim_sample(Huge(), schedule, 8, steps=1, clip=2.0)
    assert out.abs().max() <= 2.0 + 1e-5


def test_trained_model_beats_gaussian_noise():
    from datasets import make_dataset
    from metrics import chamfer_distance, gaussian_baseline

    cfg = Config(dataset="moons", steps=800, T=30, hidden=64, n_layers=3, time_dim=16,
                 n_data=2000, seed=0, ema_decay=0.99)
    model, _ = train(cfg)
    gen = ddim_sample(model, make_schedule("cosine", 30), 500, steps=15, seed=0)
    real = make_dataset("moons", 500, seed=9)
    assert chamfer_distance(gen, real) < chamfer_distance(gaussian_baseline(real, 500), real)
