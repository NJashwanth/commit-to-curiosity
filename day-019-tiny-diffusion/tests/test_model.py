import pytest
import torch

from model import Denoiser, timestep_embedding


def test_embedding_shape_and_bounded():
    emb = timestep_embedding(torch.arange(10), 32)
    assert emb.shape == (10, 32)
    assert emb.abs().max() <= 1.0


def test_embedding_differs_across_timesteps():
    emb = timestep_embedding(torch.arange(20), 16)
    dists = torch.cdist(emb, emb)
    off_diag = dists[~torch.eye(20, dtype=torch.bool)]
    assert off_diag.min() > 1e-3


def test_embedding_t0_and_odd_dim():
    emb = timestep_embedding(torch.tensor([0]), 7)
    assert emb.shape == (1, 7)
    assert emb[0, 0] == 0 and emb[0, 3] == 1  # sin(0), cos(0)
    assert emb[0, -1] == 0                     # zero pad


@pytest.mark.parametrize("learned_input", [True, False])
def test_denoiser_output_shape_and_grad(learned_input):
    model = Denoiser(hidden=32, n_layers=3, time_dim=16, learned_input=learned_input)
    x = torch.randn(9, 2)
    out = model(x, torch.randint(0, 50, (9,)))
    assert out.shape == x.shape
    out.pow(2).mean().backward()
    assert all(p.grad is not None for p in model.parameters())


def test_output_depends_on_timestep():
    torch.manual_seed(0)
    model = Denoiser(hidden=32, n_layers=3, time_dim=16)
    x = torch.randn(4, 2)
    a = model(x, torch.zeros(4, dtype=torch.long))
    b = model(x, torch.full((4,), 40))
    assert not torch.allclose(a, b)


def test_requires_a_hidden_layer():
    with pytest.raises(ValueError):
        Denoiser(n_layers=0)


def test_fourier_features_shape_and_identity_prefix():
    model = Denoiser(hidden=16, n_layers=1, time_dim=8, n_freqs=3)
    x = torch.randn(5, 2)
    feats = model.fourier_features(x)
    assert feats.shape == (5, 2 * (1 + 2 * 3))
    assert torch.equal(feats[:, :2], x)
    assert model.freqs.tolist() == [1.0, 2.0, 4.0]
