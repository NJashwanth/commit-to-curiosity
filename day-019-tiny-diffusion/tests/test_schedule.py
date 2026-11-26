import pytest
import torch

from schedule import SCHEDULES, cosine_betas, linear_betas, make_schedule


@pytest.mark.parametrize("kind", SCHEDULES)
def test_shapes_and_ranges(kind):
    s = make_schedule(kind, T=50)
    for name in ("betas", "alphas", "alpha_bars", "alpha_bars_prev", "sqrt_alpha_bars",
                 "sqrt_one_minus_alpha_bars", "posterior_variance"):
        assert getattr(s, name).shape == (50,)
    assert (s.betas > 0).all() and (s.betas <= 0.999).all()
    assert torch.allclose(s.alphas, 1 - s.betas)
    assert torch.allclose(s.sqrt_alpha_bars**2 + s.sqrt_one_minus_alpha_bars**2,
                          torch.ones(50), atol=1e-5)


@pytest.mark.parametrize("kind", SCHEDULES)
def test_alpha_bar_strictly_decreasing(kind):
    ab = make_schedule(kind, T=100).alpha_bars
    assert (ab[1:] < ab[:-1]).all()
    assert (ab > 0).all() and (ab < 1).all()


def test_linear_endpoints():
    b = linear_betas(1000)
    assert b[0].item() == pytest.approx(1e-4)
    assert b[-1].item() == pytest.approx(0.02)
    custom = linear_betas(10, beta_start=0.1, beta_end=0.5)
    assert custom[0].item() == pytest.approx(0.1) and custom[-1].item() == pytest.approx(0.5)


def test_linear_betas_stay_below_one_for_tiny_T():
    b = linear_betas(10)
    assert (b > 0).all() and (b < 1).all()


def test_cosine_endpoints():
    s = make_schedule("cosine", T=100)
    assert s.alpha_bars[0] > 0.99          # almost no noise after the first step
    assert s.alpha_bars[-1] < 1e-3         # almost pure noise at the end
    assert cosine_betas(100)[-1].item() == pytest.approx(0.999)  # clipped
    assert cosine_betas(100)[0] < 0.01


@pytest.mark.parametrize("kind", SCHEDULES)
def test_final_step_is_nearly_pure_noise(kind):
    assert make_schedule(kind, T=100).alpha_bars[-1] < 0.01


def test_posterior_variance_and_prev():
    s = make_schedule("linear", T=20)
    assert s.alpha_bars_prev[0] == 1.0
    assert torch.allclose(s.alpha_bars_prev[1:], s.alpha_bars[:-1])
    assert s.posterior_variance[0] == 0.0
    assert (s.posterior_variance <= s.betas + 1e-8).all()


def test_unknown_schedule():
    with pytest.raises(ValueError):
        make_schedule("quadratic")


@pytest.mark.parametrize("kind", SCHEDULES)
def test_closed_form_matches_iterative_noising(kind):
    """x_t from q_sample and from t one-step noisings share mean and variance."""
    torch.manual_seed(0)
    n, T, t = 40000, 30, 19
    s = make_schedule(kind, T=T)
    x0 = torch.tensor([1.5, -0.5]).repeat(n, 1)

    x = x0.clone()
    for i in range(t + 1):
        x = (1 - s.betas[i]).sqrt() * x + s.betas[i].sqrt() * torch.randn_like(x)
    closed, _ = s.q_sample(x0, torch.full((n,), t))

    assert torch.allclose(x.mean(0), closed.mean(0), atol=0.03)
    assert torch.allclose(x.var(0), closed.var(0), atol=0.03)
    # and both match the analytic moments
    ab = s.alpha_bars[t]
    assert torch.allclose(closed.mean(0), ab.sqrt() * x0[0], atol=0.03)
    assert torch.allclose(closed.var(0), (1 - ab) * torch.ones(2), atol=0.03)


def test_q_sample_returns_noise_and_respects_given_noise():
    s = make_schedule("linear", T=10)
    x0 = torch.randn(6, 2)
    noise = torch.randn(6, 2)
    t = torch.arange(6)
    xt, used = s.q_sample(x0, t, noise)
    assert used is noise
    expected = s.sqrt_alpha_bars[t, None] * x0 + s.sqrt_one_minus_alpha_bars[t, None] * noise
    assert torch.allclose(xt, expected)
    xt2, n2 = s.q_sample(x0, t)
    assert xt2.shape == x0.shape and n2.shape == x0.shape
